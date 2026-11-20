'use client';

import { isApiError, startTestPhoneCall, useApi } from '@portal/api-client';
import { testPhoneCallRequest, type TestPhoneCallResponse } from '@portal/schemas';
import { Alert, Button, Input } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { PhoneCall } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { formatPhone } from '@/src/lib/format';

/**
 * D17 "Call my phone" (W5, spec p. 24: "tel input + button; hidden until first purchase;
 * costs credits; Phase 2"). The agent rings the customer's own phone from one of their
 * numbers, on the same version as the browser test. The panel shows it only once a pack
 * has been bought; the API refuses it before then too (`PURCHASE_REQUIRED`).
 *
 * The call id goes to the after-call card straight away: it waits for the call to end and
 * fills in from `call_analyzed`, exactly as for a browser call.
 */
export function CallMyPhone({ agentId, versionNo, onPlaced }: { agentId: string; versionNo: number | null; onPlaced: (callId: string) => void }) {
  const t = useTranslations('wizard.w5.callMyPhone');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const [to, setTo] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [placed, setPlaced] = React.useState<TestPhoneCallResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    // Sent as typed: the API reads Eastern Arabic digits, `00` and a national number for
    // the workspace's country, which a strict +E.164 check here would refuse.
    const parsed = testPhoneCallRequest.shape.to.safeParse(to);
    if (!parsed.success) {
      setError(t('invalid'));
      return;
    }
    setBusy(true);
    setError(null);
    setPlaced(null);
    try {
      const call = await startTestPhoneCall(api, { id: agentId }, { to: parsed.data, ...(versionNo ? { version_no: versionNo } : {}) });
      setPlaced(call);
      onPlaced(call.call_id);
      track('test_phone_call_started', { agent_id: agentId, version_no: call.version_no });
      void queryClient.invalidateQueries({ queryKey: ['getWallet'] });
    } catch (e) {
      // VALIDATION_FAILED is a number that is not real; a real one the test may not ring
      // (another country, premium-rate, answered by an agent) has its own DESTINATION_* code
      // and its own line, so the customer knows it is the target, not the typing.
      setError(isApiError(e, 'VALIDATION_FAILED') ? t('invalid') : errorMessage(e, tc));
      track('test_phone_call_failed', { agent_id: agentId, reason: isApiError(e) ? e.code : 'network' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 border-t border-border pt-4">
      <label htmlFor="call-my-phone" className="text-sm font-medium">
        {t('title')}
      </label>
      <p className="text-xs text-muted-foreground">{t('body')}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="call-my-phone"
          type="tel"
          dir="ltr"
          inputMode="tel"
          autoComplete="tel"
          placeholder={t('placeholder')}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="sm:max-w-64"
          aria-invalid={error ? true : undefined}
        />
        <Button type="submit" variant="outline" loading={busy} disabled={busy || !to.trim()}>
          {busy ? null : <PhoneCall />} {t('call')}
        </Button>
      </div>
      {placed ? (
        <Alert variant="success">{t('placed', { to: formatPhone(placed.to_number), from: formatPhone(placed.from_number) })}</Alert>
      ) : null}
      {error ? <Alert variant="danger">{error}</Alert> : null}
    </form>
  );
}
