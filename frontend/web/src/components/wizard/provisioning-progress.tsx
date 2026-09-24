'use client';

import type { StreamState } from '@portal/api-client';
import type { ActivationStepStatus, ActivationView } from '@portal/schemas';
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress, Spinner, cn } from '@portal/ui';
import { Check, Circle, Minus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * W7 ProvisioningProgress (§13.8): the activation job's own state — status, the step in
 * flight, progress %, attempt — exactly as `activationView` carries it, whether it came
 * from an `activation:{id}` frame or the poll. Nothing here decides anything: "live" is
 * shown because the backend said `live`.
 *
 * `view = null` is the gap between Stripe's redirect and the paid webhook starting the
 * job; the page passes `waiting` copy for it.
 */
export function ProvisioningProgress({
  view,
  stream,
  waiting,
  onRetry,
  retrying,
  retryError,
}: {
  view: ActivationView | null;
  stream: StreamState;
  /** What to say while there is no activation yet. */
  waiting?: { title: string; body: string; action?: React.ReactNode };
  onRetry?: () => void;
  retrying?: boolean;
  retryError?: string | null;
}) {
  const tp = useTranslations('wizard.w7.progress');
  const t = useTranslations();

  if (!view) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Spinner className="size-4" />
            <CardTitle>{waiting?.title ?? tp('connecting')}</CardTitle>
          </div>
          {waiting?.body ? <CardDescription>{waiting.body}</CardDescription> : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Progress indeterminate aria-label={waiting?.title ?? tp('connecting')} />
          {waiting?.action ? <div>{waiting.action}</div> : null}
        </CardContent>
      </Card>
    );
  }

  const failed = view.status === 'failed';
  const live = view.status === 'live';

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{tp(`status.${view.status}`)}</CardTitle>
          {live ? <Badge variant="success">{tp('badgeLive')}</Badge> : failed ? <Badge variant="danger">{tp('badgeFailed')}</Badge> : <Badge variant="info"><Spinner className="size-3" /> {tp('badgeWorking')}</Badge>}
        </div>
        <CardDescription>{live ? tp('liveBody') : failed ? tp('failedBody') : tp('workingBody')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Progress value={view.progress} aria-label={tp('progressLabel', { pct: view.progress })} />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{tp('progressLabel', { pct: view.progress })}</span>
            {view.attempt > 1 ? <span>{tp('attempt', { n: view.attempt, max: view.max_attempts })}</span> : null}
          </div>
        </div>

        <ol className="flex flex-col gap-2" aria-live="polite">
          {view.steps.map((s) => (
            <li key={s.step} className="flex items-center gap-3 text-sm">
              <StepIcon status={s.status} />
              <span className={cn(s.status === 'pending' && 'text-muted-foreground', s.status === 'failed' && 'text-danger')}>{tp(`steps.${s.step}`)}</span>
              {s.status === 'skipped' ? <span className="text-xs text-muted-foreground">{tp('skipped')}</span> : null}
            </li>
          ))}
        </ol>

        {view.e164 ? <p className="text-sm">{tp('number', { number: view.e164 })}</p> : null}

        {failed ? (
          <Alert
            variant="danger"
            title={tp('failedTitle')}
            actions={
              onRetry ? (
                <Button size="sm" onClick={onRetry} loading={retrying} disabled={retrying}>
                  {t('common.retry')}
                </Button>
              ) : undefined
            }
          >
            {view.error ?? tp('failedDefault')}
          </Alert>
        ) : null}
        {retryError ? <Alert variant="danger">{retryError}</Alert> : null}
        {!live && !failed && stream === 'offline' ? <p className="text-xs text-muted-foreground">{tp('polling')}</p> : null}
      </CardContent>
    </Card>
  );
}

function StepIcon({ status }: { status: ActivationStepStatus }) {
  const base = 'flex size-5 shrink-0 items-center justify-center rounded-full [&_svg]:size-3';
  if (status === 'completed') return <span className={cn(base, 'bg-success text-success-foreground')}><Check aria-hidden /></span>;
  if (status === 'running') return <span className={cn(base, 'text-primary')}><Spinner className="size-4" /></span>;
  if (status === 'failed') return <span className={cn(base, 'bg-danger text-danger-foreground')}><X aria-hidden /></span>;
  if (status === 'skipped') return <span className={cn(base, 'bg-muted text-muted-foreground')}><Minus aria-hidden /></span>;
  return <span className={cn(base, 'text-muted-foreground')}><Circle aria-hidden /></span>;
}
