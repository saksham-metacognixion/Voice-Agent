'use client';

import { testNumberForwarding, useApi, useGetNumber } from '@portal/api-client';
import type { ForwardingTest, PhoneNumberResponse } from '@portal/schemas';
import { Alert, Badge, Button, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { PhoneForwarded } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime, formatPhone } from '@/src/lib/format';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/** How often the number is re-read while a test rings. The test settles within ~75 s. */
const POLL_MS = 3_000;
/**
 * How long a `not_landed` this tab watched is still re-read. The line's marker outlives
 * the ring window (90 s against 75 s), and a forward the carrier sends in that gap still
 * lands and overrules it, so the outcome can move once more.
 */
const LATE_LANDING_MS = 30_000;

/**
 * D17 "Test forwarding" on D4 (spec p. 37). `POST /numbers/:id/forwarding/test` rings the
 * customer's own line from this number; if the carrier forwarding is on, the call comes
 * straight back and is recognised. The outcome lands on the number, which this re-reads
 * every few seconds while the test reads `calling` — the same cache entry the page shows,
 * so the status badge above moves to "On" by itself.
 */
export function ForwardingTestPanel({ number }: { number: PhoneNumberResponse }) {
  const t = useTranslations('dashboard.numbers.forwarding.test');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const test = number.forwarding?.test ?? null;
  const calling = busy || test?.status === 'calling';
  const [lingering, setLingering] = React.useState(false);

  // Only a poll while one rings (and briefly after a miss); settled, the page's own query is enough.
  const polling = test?.status === 'calling' || lingering;
  useGetNumber(api, { id: number.id }, { enabled: polling, refetchInterval: polling ? POLL_MS : false });

  // An outcome is announced only for a test this tab saw ringing — started here, or
  // already ringing when the page opened (a reload mid-test) — never one that was settled
  // on load. Once per test and outcome, since a late landing can follow a miss.
  const watched = React.useRef<string | null>(null);
  const announced = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!test) return;
    if (test.status === 'calling') {
      watched.current = test.started_at;
      return;
    }
    if (!test.finished_at || watched.current !== test.started_at) return;
    const outcome = `${test.started_at}:${test.status}`;
    if (announced.current === outcome) return;
    announced.current = outcome;
    if (test.status === 'landed') toast.success(t('toast.landed'));
    else toast.warning(t('toast.notLanded'));
    track('forwarding_test_finished', { number_id: number.id, status: test.status });
    void queryClient.invalidateQueries({ queryKey: ['listNumbers'] });
    setLingering(test.status === 'not_landed');
  }, [test, t, number.id, queryClient]);

  React.useEffect(() => {
    if (!lingering) return;
    const timer = window.setTimeout(() => setLingering(false), LATE_LANDING_MS);
    return () => window.clearTimeout(timer);
  }, [lingering]);

  const start = async () => {
    setBusy(true);
    try {
      const updated = await testNumberForwarding(api, { id: number.id });
      queryClient.setQueryData(['getNumber', { id: number.id }], updated);
      track('forwarding_test_started', { number_id: number.id });
    } catch (e) {
      toast.error(errorMessage(e, tc));
      await queryClient.invalidateQueries({ queryKey: ['getNumber', { id: number.id }] });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium">{t('title')}</p>
          <p className="text-xs text-muted-foreground">{t('body', { from: formatPhone(number.forwarding!.from) })}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void start()} loading={busy} disabled={calling || !number.e164}>
          <PhoneForwarded /> {calling ? t('calling') : test ? t('again') : t('start')}
        </Button>
      </div>
      <TestLine test={busy && !test ? null : test} calling={calling} />
      {test?.status === 'not_landed' && !calling ? <Alert variant="warning">{t('notLandedHint')}</Alert> : null}
      {test?.status === 'landed' && test.caller_id === 'original' && !calling ? <p className="text-xs text-muted-foreground">{t('callerIdOriginal')}</p> : null}
      <p className="text-xs text-muted-foreground">{t('cost')}</p>
    </div>
  );
}

function TestLine({ test, calling }: { test: ForwardingTest | null; calling: boolean }) {
  const t = useTranslations('dashboard.numbers.forwarding.test');
  const timeZone = useWorkspace().workspace?.timezone;
  if (calling) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        <Badge variant="info">{t('status.calling')}</Badge> {t('ringing')}
      </p>
    );
  }
  if (!test) return <p className="text-xs text-muted-foreground">{t('never')}</p>;
  const variant = test.status === 'landed' ? 'success' : test.status === 'failed' ? 'danger' : 'warning';
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      <Badge variant={variant}>{t(`status.${test.status}`)}</Badge>
      {t('testedAt', { when: formatDateTime(test.finished_at ?? test.started_at, timeZone) })}
    </p>
  );
}
