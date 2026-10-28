'use client';

import { addDnc, isApiError, startCallback, useApi, useGetCallbackCheck, useGetFlags } from '@portal/api-client';
import type { CallbackCheck, CallDetail, OutboundRefusal } from '@portal/schemas';
import { Alert, Button, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Ban, PhoneOutgoing } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';
import { LoadError } from '@/src/components/dashboard/query-states';
import { callbackView, canListDnc, keepIdempotencyKey, showCallbackPanel } from '@/src/dashboard/callback-view';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime, formatPhone } from '@/src/lib/format';
import { callPath, routes, settingsPath } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D18 "Call back" in the D2 drawer (ADR 0031): the agent on this call rings its other
 * party from a verified number. Offered only for a phone call in a workspace whose
 * `outbound_calls` flag is on. `GET /calls/:id/callback` runs the POST's gates without
 * placing anything, so the panel says up front why a callback is not possible and where
 * to fix it; the POST runs them again, and a refusal there is shown the same way.
 */
export function CallBackPanel({ call }: { call: CallDetail }) {
  const api = useApi();
  const flags = useGetFlags(api, { staleTime: 60_000 });
  if (!showCallbackPanel(call, flags.data?.flags.outbound_calls === true)) return null;
  return <CallBackBody call={call} />;
}

/** A phone number inside a sentence keeps its left-to-right order in Arabic. */
const ltr = (chunks: React.ReactNode) => <bdi dir="ltr">{chunks}</bdi>;

function CallBackBody({ call }: { call: CallDetail }) {
  const t = useTranslations('dashboard.calls.detail.callback');
  const api = useApi();
  const check = useGetCallbackCheck(api, { id: call.id }, { staleTime: 15_000 });

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('title')}</h3>
      {check.isPending ? (
        <Skeleton className="h-20 w-full" aria-busy />
      ) : check.isError ? (
        <LoadError compact error={check.error} onRetry={() => void check.refetch()} />
      ) : (
        <CallBackControls callId={call.id} check={check.data} refetch={() => void check.refetch()} />
      )}
    </section>
  );
}

function CallBackControls({ callId, check, refetch }: { callId: string; check: CallbackCheck; refetch: () => void }) {
  const t = useTranslations('dashboard.calls.detail.callback');
  const tc = useTranslations();
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { role } = useRole();
  const timeZone = useWorkspace().workspace?.timezone;
  const view = callbackView(check, role);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ text: string; code: string | null } | null>(null);
  const [placedId, setPlacedId] = React.useState<string | null>(null);
  const [dncOpen, setDncOpen] = React.useState(false);
  // One key per press: kept across a retry when we never learned whether the call was
  // placed (the server then answers the same call), replaced after any definitive answer.
  const key = React.useRef<string | null>(null);
  // Two clicks inside one render both see `busy` false; this does not.
  const inFlight = React.useRef(false);
  const to = check.to_number ? formatPhone(check.to_number) : '';

  /** A refusal in the drawer's words: a callback-specific line where the shared one reads for another feature. */
  const errorLine = (code: string) => (tc.has(`errors.${code}`) ? tc(`errors.${code}`) : tc('errors.default'));
  const refusal = (code: OutboundRefusal | null) => (code && t.has(`reasons.${code}`) ? t(`reasons.${code}`) : code ? errorLine(code) : tc('errors.default'));
  const describe = (e: unknown) => (isApiError(e) && t.has(`reasons.${e.code}`) ? t(`reasons.${e.code}`) : errorMessage(e, tc));

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['getCallbackCheck', { id: callId }] }),
      queryClient.invalidateQueries({ queryKey: ['getOutboundOverview'] }),
    ]);

  async function place() {
    if (inFlight.current) return;
    inFlight.current = true;
    key.current ??= crypto.randomUUID();
    setBusy(true);
    setError(null);
    try {
      const placed = await startCallback(api, { id: callId }, { idempotency_key: key.current });
      key.current = null;
      setPlacedId(placed.call_id);
      track('callback_placed', { voicemail: placed.voicemail_detection });
      toast.success(t('placed', { number: formatPhone(placed.to_number) }), {
        action: { label: t('view'), onClick: () => router.push(callPath(placed.call_id)) },
      });
      void queryClient.invalidateQueries({ queryKey: ['listCalls'] });
      void refresh();
    } catch (e) {
      if (!keepIdempotencyKey(e)) key.current = null;
      if (isApiError(e)) track('callback_refused', { code: e.code });
      setError({ text: describe(e), code: isApiError(e) ? e.code : null });
      refetch();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
      {view.kind === 'ready' ? (
        <>
          <div className="flex flex-col gap-1 text-sm">
            <p>
              {t.rich('body', { number: to, from: check.from_number ? formatPhone(check.from_number) : '–', num: ltr })}
            </p>
            <p className="text-xs text-muted-foreground">{t(`voicemail.${check.voicemail_detection}`)}</p>
            <p className="text-xs text-muted-foreground">{t('usage', { used: check.used_today, cap: check.daily_cap })}</p>
          </div>
          {view.canPlace ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void place()} loading={busy} disabled={busy}>
                <PhoneOutgoing aria-hidden /> {t.rich('button', { number: to, num: ltr })}
              </Button>
              {placedId ? (
                <Button size="sm" variant="outline" onClick={() => router.push(callPath(placedId))}>
                  {t('view')}
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('viewerNote')}</p>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-1.5 text-sm">
          <p className="text-warning-emphasis">{refusal(view.reason)}</p>
          {view.nextAllowedAt ? <p className="text-xs text-muted-foreground">{t('earliest', { when: formatDateTime(view.nextAllowedAt, timeZone) })}</p> : null}
          {view.fix === 'settings' ? (
            <Link href={settingsPath('outbound')} className="text-xs text-primary hover:underline">
              {t('openSettings')}
            </Link>
          ) : view.fix === 'wallet' ? (
            <Link href={routes.app.wallet} className="text-xs text-primary hover:underline">
              {t('openWallet')}
            </Link>
          ) : null}
        </div>
      )}

      {/* A refusal the re-read check now reports itself is already said above. */}
      {error && !(view.kind === 'blocked' && error.code === view.reason) ? <Alert variant="danger">{error.text}</Alert> : null}

      <p className="text-xs text-muted-foreground">{t('rule', { days: check.prior_contact_days })}</p>

      {canListDnc(check, role) ? (
        <div className="flex justify-end border-t border-border pt-3">
          <Button size="sm" variant="ghost" onClick={() => setDncOpen(true)}>
            <Ban aria-hidden /> {t('dnc.add')}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={dncOpen}
        onOpenChange={setDncOpen}
        title={t.rich('dnc.title', { number: to, num: ltr })}
        description={t('dnc.body')}
        confirmLabel={t('dnc.confirm')}
        onConfirm={async () => {
          await addDnc(api, { call_id: callId });
          track('dnc_added', { source: 'call' });
          toast.success(t('dnc.added', { number: to }));
          setError(null);
          await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['listDnc'] })]);
        }}
      />
    </div>
  );
}
