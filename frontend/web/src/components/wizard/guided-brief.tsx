'use client';

import { briefFromAnswers, isApiError, useApi } from '@portal/api-client';
import { GUIDED_ANSWER_MAX_CHARS, GUIDED_QUESTIONS, type BriefPatch, type BriefReviewField, type GuidedAnswers, type GuidedBriefField, type GuidedQuestionId, answeredQuestions } from '@portal/schemas';
import { Alert, Button, Progress, Textarea, cn, toast } from '@portal/ui';
import { ArrowLeft, ArrowRight, Keyboard, Mic, RotateCcw, Square, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { MicDeniedHelp } from '@/src/components/wizard/mic-denied-help';
import { errorMessage } from '@/src/lib/errors';
import { GUIDED_TOTAL, type GuidedMode, addTranscript, answersToSend, guidedModes, loadAnswers, resumeIndex, saveAnswers, withAnswer } from '@/src/wizard/guided-brief';
import { useSpeechCapture } from '@/src/wizard/use-speech-capture';

export interface GuidedApplyResult {
  /** The fields the answers changed. */
  changed: GuidedBriefField[];
  /** The fields the form still holds nothing for. */
  empty: BriefReviewField[];
}

export interface GuidedBriefProps {
  agentId: string;
  /** A generation is running: the brief must not change under it. */
  disabled?: boolean;
  /** Lays the patch over the W2 form and answers which fields changed and which are still empty. */
  onApply: (patch: BriefPatch) => GuidedApplyResult;
  /** Puts the form back to what it held before the last `onApply`. */
  onUndo: () => void;
  /** The answers are with the model: the page holds Generate back until the patch is in the form. */
  onSendingChange?: (sending: boolean) => void;
  className?: string;
}

type Phase = 'closed' | 'asking' | 'review' | 'done';

/** Phone-width tap target; the design system's default button is 40 px. */
const TAP = 'max-sm:h-11';

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * W2 "Speak or type" (ADR 0047). The same eight questions either way: Speak fills the
 * answer box from the browser's speech recognition, Type from the keyboard, and both end
 * at one review and one request. The result goes into the W2 form below, where the
 * customer checks it; nothing here generates a script.
 */
export function GuidedBrief({ agentId, disabled = false, onApply, onUndo, onSendingChange, className }: GuidedBriefProps) {
  const t = useTranslations();
  const tg = useTranslations('wizard.w2.guided');
  const tf = useTranslations('wizard.w2.fields');
  const locale = useLocale();
  const api = useApi();

  const [answers, setAnswers] = React.useState<GuidedAnswers>(() => loadAnswers(sessionStore(), agentId));
  const [phase, setPhase] = React.useState<Phase>('closed');
  const [mode, setMode] = React.useState<GuidedMode>('type');
  const [index, setIndex] = React.useState(0);
  const [fromReview, setFromReview] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [empty, setEmpty] = React.useState(false);
  const [changed, setChanged] = React.useState<GuidedBriefField[]>([]);
  const [stillEmpty, setStillEmpty] = React.useState<BriefReviewField[]>([]);

  const id = GUIDED_QUESTIONS[index]!;
  const currentId = React.useRef(id);
  currentId.current = id;
  // "Record again" replaces the answer with the first phrase heard, so a recording that fails or hears nothing loses nothing.
  const replaceOnHeard = React.useRef<GuidedQuestionId | null>(null);
  const speech = useSpeechCapture(locale, (heard) => {
    const question = currentId.current;
    const fresh = replaceOnHeard.current === question;
    replaceOnHeard.current = null;
    setAnswers((prev) => withAnswer(prev, question, addTranscript(fresh ? '' : (prev[question] ?? ''), heard)));
  });
  const modes = guidedModes(speech.supported);
  const answer = answers[id] ?? '';
  const answered = answeredQuestions(answers);

  React.useEffect(() => saveAnswers(sessionStore(), agentId, answers), [agentId, answers]);

  // Generate can be pressed while the microphone is on; the brief is locked from then, so the recording ends.
  const cancelSpeech = speech.cancel;
  React.useEffect(() => {
    if (disabled) cancelSpeech();
  }, [disabled, cancelSpeech]);

  React.useEffect(() => {
    if (speech.status === 'idle') replaceOnHeard.current = null;
  }, [speech.status]);

  // A reply that lands after Generate was pressed, or after the page was left, is not applied.
  const locked = React.useRef(disabled);
  locked.current = disabled;
  const mounted = React.useRef(true);
  const sendingChanged = React.useRef(onSendingChange);
  sendingChanged.current = onSendingChange;
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sendingChanged.current?.(false);
    };
  }, []);

  const answerRef = React.useRef<HTMLTextAreaElement>(null);
  const micRef = React.useRef<HTMLButtonElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  // Each new question, the review and the result take focus, so a keyboard or screen-reader user lands on them.
  React.useEffect(() => {
    if (phase === 'asking') (mode === 'speak' ? micRef.current : answerRef.current)?.focus();
    else if (phase === 'review' || phase === 'done') headingRef.current?.focus();
  }, [phase, index, mode]);

  function open(next: GuidedMode) {
    setMode(next);
    setIndex(resumeIndex(answers));
    setFromReview(false);
    setError(null);
    setEmpty(false);
    setPhase('asking');
    track('guided_brief_started', { agent_id: agentId, mode: next, resumed: answered.length > 0 });
  }

  function switchMode(next: GuidedMode) {
    if (next === mode) return;
    speech.cancel();
    speech.clearFailure();
    setMode(next);
  }

  function close() {
    speech.cancel();
    speech.clearFailure();
    setPhase('closed');
  }

  function go(target: number) {
    speech.clearFailure();
    if (fromReview || target >= GUIDED_TOTAL) {
      setFromReview(false);
      setPhase('review');
      return;
    }
    setIndex(Math.max(0, target));
  }

  function edit(target: number) {
    setIndex(target);
    setFromReview(true);
    setError(null);
    setEmpty(false);
    setPhase('asking');
  }

  function backToQuestions() {
    setIndex(GUIDED_TOTAL - 1);
    setFromReview(false);
    setError(null);
    setEmpty(false);
    setPhase('asking');
  }

  function record() {
    replaceOnHeard.current = null;
    speech.start();
  }

  function recordAgain() {
    replaceOnHeard.current = id;
    speech.start();
  }

  async function submit() {
    const toSend = answersToSend(answers);
    if (Object.keys(toSend).length === 0 || sending || disabled) return;
    setSending(true);
    onSendingChange?.(true);
    setError(null);
    setEmpty(false);
    try {
      const result = await briefFromAnswers(api, { id: agentId }, { answers: toSend });
      if (!mounted.current || locked.current) return;
      const { changed: fields, empty: unfilled } = onApply(result.brief);
      track('guided_brief_applied', { agent_id: agentId, mode, answered: Object.keys(toSend).length, fields: fields.length });
      if (fields.length === 0) {
        setEmpty(true);
        return;
      }
      setChanged(fields);
      setStillEmpty(unfilled);
      setPhase('done');
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
      onSendingChange?.(false);
    }
  }

  function undo() {
    onUndo();
    setPhase('closed');
    toast.success(tg('done.undone'));
  }

  const shell = cn('rounded-lg border border-border bg-card p-5 shadow-card sm:p-6 [&_button:not(:disabled)]:cursor-pointer', className);

  if (phase === 'done') {
    // `never_do_presets` and `services_notes` sit under their neighbour's label in the form.
    const labels = [...new Set(changed.map((field) => (field === 'never_do_presets' ? 'never_do' : field === 'services_notes' ? 'services' : field)))].map((field) => tf(`${field}.label`));
    return (
      <section className={shell} aria-labelledby="guided-title" data-testid="guided-brief" data-phase="done">
        <Alert
          variant="success"
          title={
            <span id="guided-title" ref={headingRef} tabIndex={-1} className="outline-none">
              {tg('done.title')}
            </span>
          }
          actions={
            <>
              <Button size="sm" variant="outline" className={TAP} onClick={undo} disabled={disabled} data-testid="guided-undo">
                <RotateCcw aria-hidden /> {tg('done.undo')}
              </Button>
              <Button size="sm" variant="ghost" className={TAP} onClick={() => setPhase('review')} disabled={disabled}>
                {tg('done.again')}
              </Button>
            </>
          }
        >
          {tg('done.body', { fields: labels.join(t('common.listSeparator')) })}
          {stillEmpty.length > 0 ? (
            <span className="mt-1 block" data-testid="guided-still-empty">
              {tg('done.stillEmpty', { fields: stillEmpty.map((field) => tf(`${field}.label`)).join(t('common.listSeparator')) })}
            </span>
          ) : null}
        </Alert>
      </section>
    );
  }

  if (phase === 'closed') {
    return (
      <section className={shell} aria-labelledby="guided-title" data-testid="guided-brief" data-phase="closed">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between lg:gap-8">
          <div className="min-w-0">
            <h2 id="guided-title" className="text-base font-semibold tracking-tight">
              {tg('title')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{tg('body', { total: GUIDED_TOTAL })}</p>
            {answered.length > 0 ? <p className="mt-1 text-sm text-foreground">{tg('resume')}</p> : null}
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
            {modes.includes('speak') ? (
              <Button size="lg" variant="outline" onClick={() => open('speak')} disabled={disabled} data-testid="guided-speak">
                <Mic aria-hidden /> {tg('speak')}
              </Button>
            ) : null}
            <Button size="lg" variant="outline" onClick={() => open('type')} disabled={disabled} data-testid="guided-type">
              <Keyboard aria-hidden /> {tg('type')}
            </Button>
          </div>
        </div>
        <p className="mt-4 text-xs text-muted-foreground" data-testid="guided-note">
          {modes.includes('speak') ? tg('micNote') : tg('typeOnly')}
        </p>
      </section>
    );
  }

  if (phase === 'review') {
    const failed = error !== null;
    const failure = failed ? (isApiError(error, 'RATE_LIMITED') ? tg('review.rateLimited') : isApiError(error, 'UPSTREAM_UNAVAILABLE') || isApiError(error, 'NOT_CONFIGURED') ? tg('review.unavailable') : errorMessage(error, t)) : null;
    return (
      <section className={shell} aria-labelledby="guided-title" data-testid="guided-brief" data-phase="review">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="guided-title" ref={headingRef} tabIndex={-1} className="text-base font-semibold tracking-tight outline-none">
              {tg('review.title')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{tg('review.body')}</p>
          </div>
          <Button size="icon" variant="ghost" className="max-sm:size-11" onClick={close} aria-label={tg('close')} disabled={sending}>
            <X aria-hidden />
          </Button>
        </div>
        <ol className="mt-4 divide-y divide-border border-y border-border" data-testid="guided-review">
          {GUIDED_QUESTIONS.map((question, i) => {
            const text = answers[question]?.trim();
            return (
              <li key={question} className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{tg(`questions.${question}.label`)}</p>
                  {text ? (
                    <p dir="auto" className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {text}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-sm italic text-muted-foreground">{tg('review.skipped')}</p>
                  )}
                </div>
                <Button size="sm" variant="outline" className={TAP} onClick={() => edit(i)} disabled={sending || disabled} aria-label={tg('review.editLabel', { question: tg(`questions.${question}.label`) })}>
                  {tg('review.edit')}
                </Button>
              </li>
            );
          })}
        </ol>
        <div className="mt-4 flex flex-col gap-3" aria-live="polite">
          {failure ? (
            <Alert variant="danger" title={tg('review.failedTitle')} data-testid="guided-error">
              {failure}
            </Alert>
          ) : null}
          {empty ? (
            <Alert variant="warning" title={tg('review.emptyTitle')} data-testid="guided-empty">
              {tg('review.emptyBody')}
            </Alert>
          ) : null}
          {sending ? <p className="text-sm text-muted-foreground">{tg('review.sending')}</p> : null}
          {answered.length === 0 ? <p className="text-sm text-muted-foreground">{tg('review.none')}</p> : null}
        </div>
        <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button variant="ghost" size="lg" onClick={backToQuestions} disabled={sending}>
            <ArrowLeft aria-hidden /> {tg('review.back')}
          </Button>
          <Button size="lg" onClick={() => void submit()} loading={sending} disabled={answered.length === 0 || disabled} data-testid="guided-submit">
            {failed ? t('common.retry') : tg('review.submit')}
          </Button>
        </div>
      </section>
    );
  }

  const speaking = mode === 'speak';
  const listening = speech.status === 'listening';
  const statusLine = speech.status === 'starting' ? tg('speech.starting') : listening ? tg('speech.listening') : speech.status === 'processing' ? tg('speech.processing') : answer.trim() ? tg('speech.idleAnswered') : tg('speech.idle');
  const typeInstead = (
    <Button size="sm" variant="outline" className={TAP} onClick={() => switchMode('type')}>
      <Keyboard aria-hidden /> {tg('speech.typeInstead')}
    </Button>
  );

  return (
    <section className={shell} aria-labelledby="guided-question" data-testid="guided-brief" data-phase="asking" data-mode={mode}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground" data-testid="guided-progress">
          {tg('progress', { n: index + 1, total: GUIDED_TOTAL })}
        </p>
        <div className="flex items-center gap-2">
          {modes.length > 1 ? (
            <div role="group" aria-label={tg('mode.label')} className="flex rounded-md border border-border p-0.5">
              {modes.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={mode === option}
                  onClick={() => switchMode(option)}
                  data-testid={`guided-mode-${option}`}
                  className={cn(
                    'inline-flex h-9 items-center gap-1.5 rounded-[5px] px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 max-sm:h-11',
                    mode === option ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {option === 'speak' ? <Mic className="size-4" aria-hidden /> : <Keyboard className="size-4" aria-hidden />}
                  {tg(`mode.${option}`)}
                </button>
              ))}
            </div>
          ) : null}
          <Button size="icon" variant="ghost" className="max-sm:size-11" onClick={close} aria-label={tg('close')}>
            <X aria-hidden />
          </Button>
        </div>
      </div>
      <Progress className="mt-3" value={((index + 1) / GUIDED_TOTAL) * 100} aria-label={tg('progress', { n: index + 1, total: GUIDED_TOTAL })} />

      <h2 id="guided-question" className="mt-5 text-lg font-semibold tracking-tight sm:text-xl" data-testid="guided-question">
        {tg(`questions.${id}.title`)}
      </h2>
      <p id="guided-hint" className="mt-1 text-sm text-muted-foreground">
        {tg(`questions.${id}.hint`)}
      </p>

      {speaking ? (
        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {speech.active ? (
              <Button ref={micRef} size="lg" variant="danger" onClick={speech.stop} disabled={speech.status === 'processing'} aria-describedby="guided-question" data-testid="guided-mic-stop">
                <Square aria-hidden /> {tg('speech.stop')}
              </Button>
            ) : (
              <Button ref={micRef} size="lg" onClick={record} disabled={disabled} aria-describedby="guided-question" data-testid="guided-mic-start">
                <Mic aria-hidden /> {answer.trim() ? tg('speech.more') : tg('speech.start')}
              </Button>
            )}
            {answer.trim() && !speech.active ? (
              <Button size="lg" variant="outline" onClick={recordAgain} disabled={disabled} data-testid="guided-mic-again">
                <RotateCcw aria-hidden /> {tg('speech.again')}
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground" role="status" data-testid="guided-speech-status" data-status={speech.status}>
            {listening ? <span className="me-2 inline-block size-2 rounded-full bg-danger align-middle" aria-hidden /> : null}
            {statusLine}
          </p>
          {speech.failure === 'denied' ? (
            <MicDeniedHelp actions={typeInstead} lastStep={tg('speech.errors.deniedRetry')}>
              {tg('speech.errors.denied')}
            </MicDeniedHelp>
          ) : speech.failure ? (
            <Alert variant={speech.failure === 'no_speech' ? 'warning' : 'danger'} title={tg(`speech.errors.${speech.failure}.title`)} actions={speech.failure === 'no_speech' ? undefined : typeInstead} data-testid="guided-speech-error" data-failure={speech.failure}>
              {tg(`speech.errors.${speech.failure}.body`)}
            </Alert>
          ) : null}
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label id="guided-answer-label" htmlFor="guided-answer" className="text-sm font-medium">
            {speaking ? tg('heard') : tg('answer')}
          </label>
          <span className="text-xs tabular-nums text-muted-foreground">
            {answer.length}/{GUIDED_ANSWER_MAX_CHARS}
          </span>
        </div>
        <Textarea
          ref={answerRef}
          id="guided-answer"
          rows={4}
          maxLength={GUIDED_ANSWER_MAX_CHARS}
          value={answer}
          onChange={(e) => setAnswers((prev) => withAnswer(prev, id, e.target.value))}
          readOnly={speech.active}
          disabled={disabled}
          placeholder={speaking ? tg('heardPlaceholder') : tg('answerPlaceholder')}
          aria-labelledby="guided-question guided-answer-label"
          aria-describedby={speaking ? 'guided-heard-hint' : 'guided-hint'}
          data-testid="guided-answer"
        />
        {speaking && speech.interim ? (
          <p dir="auto" className="text-sm italic text-muted-foreground" data-testid="guided-interim">
            {speech.interim}
          </p>
        ) : null}
        {speaking ? (
          <p id="guided-heard-hint" className="text-xs text-muted-foreground">
            {tg('heardHint')}
          </p>
        ) : null}
      </div>

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button variant="ghost" size="lg" onClick={() => go(index - 1)} disabled={index === 0 || speech.active || fromReview} data-testid="guided-back">
          <ArrowLeft aria-hidden /> {tg('previous')}
        </Button>
        <Button size="lg" variant={speaking && !answer.trim() ? 'outline' : 'primary'} onClick={() => go(index + 1)} disabled={speech.active} data-testid="guided-next">
          {fromReview ? tg('backToReview') : !answer.trim() ? tg('skip') : index === GUIDED_TOTAL - 1 ? tg('toReview') : t('common.next')}
          {fromReview ? null : <ArrowRight aria-hidden />}
        </Button>
      </div>
    </section>
  );
}
