import { GUIDED_ANSWER_MAX_CHARS, GUIDED_QUESTIONS, type GuidedAnswers, type GuidedQuestionId, guidedAnswers } from '@portal/schemas';

/*
 * W2 "Speak or type" (ADR 0047): the answers to the guided questions while they are being
 * given. Speak and Type write into the same answers, so both reach the same review and
 * the same request.
 */

export type GuidedMode = 'speak' | 'type';

export const GUIDED_TOTAL = GUIDED_QUESTIONS.length;

/** Speak is offered only where the browser can do it; Type always. */
export function guidedModes(speech: boolean): GuidedMode[] {
  return speech ? ['speak', 'type'] : ['type'];
}

/** One answer changed, the rest untouched. Text past the limit is cut, never refused. */
export function withAnswer(answers: GuidedAnswers, id: GuidedQuestionId, text: string): GuidedAnswers {
  return { ...answers, [id]: text.slice(0, GUIDED_ANSWER_MAX_CHARS) };
}

/** What is sent: trimmed answers, blank and skipped questions left out. */
export function answersToSend(answers: GuidedAnswers): GuidedAnswers {
  const out: GuidedAnswers = {};
  for (const id of GUIDED_QUESTIONS) {
    const text = answers[id]?.trim();
    if (text) out[id] = text;
  }
  return out;
}

const SENTENCE_END = /[.!?؟。]$/;

/**
 * A recognised phrase added to the answer so far. Browsers return phrases without a
 * leading capital or spacing, so the join adds the space and starts a sentence with a
 * capital (a no-op in Arabic). The result respects the answer limit.
 */
export function addTranscript(current: string, heard: string): string {
  const phrase = heard.replace(/\s+/g, ' ').trim();
  if (!phrase) return current;
  const before = current.trimEnd();
  const startsSentence = before === '' || SENTENCE_END.test(before);
  const text = startsSentence ? phrase.charAt(0).toLocaleUpperCase() + phrase.slice(1) : phrase;
  return (before ? `${before} ${text}` : text).slice(0, GUIDED_ANSWER_MAX_CHARS);
}

/** The first question without an answer, else the last one: where "pick up where you left off" opens. */
export function resumeIndex(answers: GuidedAnswers): number {
  const index = GUIDED_QUESTIONS.findIndex((id) => !answers[id]?.trim());
  return index === -1 ? GUIDED_TOTAL - 1 : index;
}

type AnswerStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const storageKey = (agentId: string) => `portal:guided-brief:${agentId}`;

/** Answers in progress survive a reload (session storage, this tab only). Unreadable storage reads as none. */
export function loadAnswers(store: AnswerStore | null | undefined, agentId: string): GuidedAnswers {
  try {
    const parsed = guidedAnswers.safeParse(JSON.parse(store?.getItem(storageKey(agentId)) ?? 'null'));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function saveAnswers(store: AnswerStore | null | undefined, agentId: string, answers: GuidedAnswers): void {
  try {
    if (Object.keys(answersToSend(answers)).length === 0) store?.removeItem(storageKey(agentId));
    else store?.setItem(storageKey(agentId), JSON.stringify(answers));
  } catch {
    // Private mode or a full quota: the answers live in memory only.
  }
}
