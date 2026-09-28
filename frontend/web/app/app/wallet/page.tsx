'use client';

import { confirmCheckout, useApi, useGetWallet } from '@portal/api-client';
import { Alert, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { PageHeader } from '@/src/components/shell/portal-shell';
import { AutoTopupCard, BalanceCard, ExpiringCard, InvoicesCard, LedgerCard, PaymentMethodsCard, UsageCard } from '@/src/components/dashboard/wallet/wallet-sections';
import { errorMessage } from '@/src/lib/errors';
import { useUrlQuery } from '@/src/lib/use-url-query';
import { useRole } from '@/src/workspace/use-role';

/**
 * D5 Wallet & billing (spec pp. 37–38, Figure 12). Owner/admin see everything; an editor
 * or viewer sees the balance, usage and the ledger only (spec p. 37).
 *
 * The balance card, the pill in the shell and the ledger all move on the shell's SSE
 * stream. Back from a Stripe Checkout started here (`?checkout=success&session_id=`),
 * the page confirms the session with the API once — the same fulfilment as the webhook,
 * so a late or lost webhook cannot leave a paid customer without credits (ADR 0013 §9).
 */
export default function WalletPage() {
  const t = useTranslations('dashboard.wallet');
  const api = useApi();
  const { canAdmin } = useRole();
  const wallet = useGetWallet(api, { staleTime: 15_000 });
  useCheckoutReturn(canAdmin);

  return (
    <>
      <PageHeader title={t('title')} description={t('subtitle')} />
      {!canAdmin ? <Alert variant="neutral">{t('viewerNote')}</Alert> : null}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <BalanceCard />
        {/* The expiring card is the admin grid's below; here it is the viewer's second card, never a stand-in while the wallet loads. */}
        {canAdmin ? wallet.data ? <AutoTopupCard wallet={wallet.data} /> : wallet.isError ? null : <Skeleton className="h-48 w-full" aria-busy /> : <ExpiringCard />}
      </div>
      <UsageCard />
      {canAdmin ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <ExpiringCard />
          {wallet.data ? <PaymentMethodsCard wallet={wallet.data} /> : null}
        </div>
      ) : null}
      <LedgerCard />
      {canAdmin ? <InvoicesCard /> : null}
    </>
  );
}

function useCheckoutReturn(canAdmin: boolean) {
  const t = useTranslations('dashboard.wallet.checkout');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const [params, setParams] = useUrlQuery();
  const handled = React.useRef(false);
  const outcome = params.get('checkout');
  const sessionId = params.get('session_id');

  React.useEffect(() => {
    if (handled.current || !outcome) return;
    handled.current = true;
    const clear = () =>
      setParams((next) => {
        next.delete('checkout');
        next.delete('session_id');
      }, 'replace');

    if (outcome === 'cancelled') {
      track('checkout_cancelled', { from: 'wallet' });
      toast(t('cancelled'));
      clear();
      return;
    }
    if (outcome !== 'success' || !sessionId || !canAdmin) {
      clear();
      return;
    }
    track('checkout_returned', { from: 'wallet' });
    const pending = toast.loading(t('confirming'));
    confirmCheckout(api, { session_id: sessionId })
      .then(async (res) => {
        track('checkout_confirmed', { status: res.status, credited: res.credited, from: 'wallet' });
        await Promise.all(['getWallet', 'listLedger', 'listCreditLots', 'listInvoices'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
        toast.success(res.status === 'paid' ? t('credited') : t('pending'), { id: pending });
      })
      .catch((e: unknown) => toast.error(`${t('failed')} ${errorMessage(e, tc)}`, { id: pending }))
      .finally(clear);
  }, [outcome, sessionId, canAdmin, api, queryClient, setParams, t, tc]);
}
