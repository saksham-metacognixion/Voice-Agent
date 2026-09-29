'use client';

import { activateAgent, confirmCheckout, isApiError, useApi } from '@portal/api-client';
import type { AgentDetail } from '@portal/schemas';
import { Alert, Button } from '@portal/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { OnboardingAgentLoader } from '@/src/components/wizard/agent-loader';
import { PackageSelector } from '@/src/components/wizard/package-selector';
import { ProvisioningProgress } from '@/src/components/wizard/provisioning-progress';
import { WizardHeading } from '@/src/components/wizard/wizard-shell';
import { OnboardingStepGuard } from '@/src/guards/guards';
import { errorMessage } from '@/src/lib/errors';
import { readQuery } from '@/src/lib/query-string';
import { routes } from '@/src/routes';
import { checkoutMarker } from '@/src/wizard/checkout-marker';
import { useActivation } from '@/src/wizard/use-activation';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/** After this long back from Stripe with no activation, say so and offer to start it. */
const CONFIRM_PATIENCE_MS = 90_000;

/**
 * W7 — Choose a pack and go live (§13.7, §13.8).
 *
 *   PackSelector → POST /wallet/checkout → Stripe Checkout
 *     → back to /onboarding/activate?session_id=…   (or ?checkout=cancelled)
 *     → POST /wallet/checkout/confirm: the API asks Stripe about the session and credits
 *       the pack if the webhook has not — the paid webhook and the confirm are the same
 *       fulfilment, so whichever lands first wins and the other is a no-op
 *     → the credited purchase starts the activation job (agent_id rode on the session)
 *       → activation:{id} frames + GET /agents/:id/activation
 *     → live → /onboarding/knowledge (what the agent knows, ADR 0024) → /onboarding/live
 *
 * `session_id` in the URL only says Stripe sent the customer back; it proves nothing to
 * this page. It is handed to the API, which trusts Stripe's answer and nothing else. What
 * this page shows comes from the activation the backend created, and the backend starts
 * one only from a paid purchase. A refresh anywhere in this lands on the same state,
 * because that state is on the server.
 */
export default function ActivatePage() {
  return (
    <OnboardingStepGuard step={7} completeRedirect={routes.onboarding.knowledge}>
      <OnboardingAgentLoader>{(agent) => <ActivateInner agent={agent} />}</OnboardingAgentLoader>
    </OnboardingStepGuard>
  );
}

function ActivateInner({ agent }: { agent: AgentDetail }) {
  const t = useTranslations();
  const tw = useTranslations('wizard.w7');
  const api = useApi();
  const router = useRouter();
  const ws = useWorkspace();

  // Read once: the query string is Stripe's hand-back, not live state.
  const [ret] = React.useState(() => {
    const q = readQuery();
    return { sessionId: q.get('session_id'), cancelled: q.get('checkout') === 'cancelled', marker: checkoutMarker.get(agent.id), at: Date.now() };
  });
  const returned = Boolean(ret.sessionId);
  const activation = useActivation(agent.id, { since: returned ? (ret.marker?.startedAt ?? null) : null });
  const view = activation.view;

  const [choosing, setChoosing] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);
  const [retryError, setRetryError] = React.useState<string | null>(null);
  const [patienceOver, setPatienceOver] = React.useState(false);
  /** What the API said about the checkout after asking Stripe; null until it has answered. */
  const [confirmed, setConfirmed] = React.useState<'pending' | 'paid' | 'abandoned' | null>(null);
  const [confirmError, setConfirmError] = React.useState<string | null>(null);
  const confirming = React.useRef(false);
  const refetchActivation = React.useRef(activation.refetch);
  refetchActivation.current = activation.refetch;

  // The URL's session_id is handed to the API, which asks Stripe. This credits the pack
  // (and starts the activation) when the webhook has not arrived; without it a lost
  // delivery leaves a paid customer on this screen for ever.
  const confirm = React.useCallback(async () => {
    if (!ret.sessionId || confirming.current) return;
    confirming.current = true;
    setConfirmError(null);
    try {
      const res = await confirmCheckout(api, { session_id: ret.sessionId });
      setConfirmed(res.status === 'paid' || res.status === 'refunded' ? 'paid' : res.status);
      if (res.credited) track('checkout_confirmed', { agent_id: agent.id, purchase_id: res.purchase_id });
      if (res.status === 'paid') refetchActivation.current();
    } catch (e) {
      // NOT_FOUND: a link for a purchase that is not this workspace's. The webhook path still stands.
      if (!isApiError(e, 'NOT_FOUND')) setConfirmError(errorMessage(e, t));
    } finally {
      confirming.current = false;
    }
  }, [api, ret.sessionId, agent.id, t]);

  React.useEffect(() => {
    if (returned) {
      track('checkout_returned', { agent_id: agent.id, pack_id: ret.marker?.packId ?? null });
      void confirm();
    }
    if (ret.cancelled) track('checkout_cancelled', { agent_id: agent.id });
  }, [returned, ret.cancelled, ret.marker, agent.id, confirm]);

  React.useEffect(() => {
    if (!returned || view) return;
    const timer = setTimeout(() => setPatienceOver(true), Math.max(0, ret.at + CONFIRM_PATIENCE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [returned, view, ret.at]);

  // Live: the job wrote `onboarding_completed_at` in the same transaction as the agent's
  // status. Re-read the workspace so every guard agrees, then ask what the agent should know.
  const wentLive = view?.status === 'live';
  const refetchWorkspace = ws.refetchWorkspace;
  const handedOff = React.useRef(false);
  React.useEffect(() => {
    if (!wentLive || handedOff.current) return;
    handedOff.current = true;
    checkoutMarker.clear();
    track('checkout_completed', { agent_id: agent.id });
    track('agent_live', { agent_id: agent.id });
    void refetchWorkspace().finally(() => router.replace(routes.onboarding.knowledge));
  }, [wentLive, agent.id, refetchWorkspace, router]);

  async function startActivation() {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    try {
      await activateAgent(api, { id: agent.id }, {});
      activation.refetch();
    } catch (e) {
      if (isApiError(e, 'ACTIVATION_IN_PROGRESS') || isApiError(e, 'CONFLICT')) activation.refetch();
      else setRetryError(errorMessage(e, t));
    } finally {
      setRetrying(false);
    }
  }

  // An activation in flight, finished, or failed after a payment is this page's subject;
  // so is the wait right after Stripe hands the customer back. Otherwise: pick a pack.
  const showProgress = !choosing && (returned || (view !== null && view.status !== 'failed') || (view?.status === 'failed' && !ret.cancelled));

  return (
    <>
      <WizardHeading title={showProgress ? tw('progressTitle') : tw('title')} subtitle={showProgress ? tw('progressSubtitle') : tw('subtitle')} />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        {ret.cancelled && !showProgress ? <Alert variant="warning" title={tw('cancelledTitle')}>{tw('cancelledBody')}</Alert> : null}
        {activation.error ? (
          <Alert variant="danger" title={t('errors.loadFailed')} actions={<Button size="sm" variant="outline" onClick={activation.refetch}>{t('common.retry')}</Button>}>
            {errorMessage(activation.error, t)}
          </Alert>
        ) : null}

        {showProgress ? (
          <>
            <ProvisioningProgress
              view={view}
              stream={activation.stream}
              onRetry={() => void startActivation()}
              retrying={retrying}
              retryError={retryError}
              waiting={{
                title: confirmed === 'paid' && !patienceOver ? tw('confirm.paidTitle') : patienceOver ? tw('confirm.slowTitle') : tw('confirm.title'),
                body: confirmed === 'paid' && !patienceOver ? tw('confirm.paidBody') : patienceOver ? tw('confirm.slowBody') : tw('confirm.body'),
                action: patienceOver ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => void startActivation()} loading={retrying} disabled={retrying}>
                      {tw('confirm.start')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void confirm();
                        activation.refetch();
                      }}
                    >
                      {tw('confirm.check')}
                    </Button>
                  </div>
                ) : undefined,
              }}
            />
            {confirmed === 'abandoned' && !view ? <Alert variant="warning">{tw('confirm.notPaid')}</Alert> : null}
            {confirmError && !view ? <Alert variant="warning">{confirmError}</Alert> : null}
            {retryError && !view ? <Alert variant="danger">{retryError}</Alert> : null}
            {view?.status === 'failed' || (patienceOver && !view) ? (
              <p className="text-sm text-muted-foreground">
                {tw('otherPack')}{' '}
                <Button variant="link" onClick={() => setChoosing(true)}>
                  {tw('otherPackAction')}
                </Button>
              </p>
            ) : null}
          </>
        ) : (
          <PackageSelector agentId={agent.id} />
        )}
      </div>
    </>
  );
}
