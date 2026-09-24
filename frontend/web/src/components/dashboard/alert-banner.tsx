'use client';

import { useApi, useDismissAlert, useListActiveAlerts } from '@portal/api-client';
import type { AlertResponse } from '@portal/schemas';
import { Alert, Button } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';
import { formatCreditsValue, formatPhone } from '@/src/lib/format';
import { routes } from '@/src/routes';

/**
 * D1 alert banner (spec p. 33): the open, undismissed alerts from `GET /alerts/active`
 * — low balance, an overdue number rental, a released number, the concurrency cap, a
 * failed auto top-up (D7). Dismissing hides; the condition is resolved by the system
 * when it clears. The `alerts` SSE topic refreshes the list, so a new one appears
 * without a reload.
 */
export function AlertBanner() {
  const t = useTranslations('dashboard.alerts');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const alerts = useListActiveAlerts(api, { staleTime: 30_000 });
  const dismiss = useDismissAlert(api);
  const [busy, setBusy] = React.useState<string | null>(null);

  if (alerts.isPending) return null;
  if (alerts.isError) {
    return (
      <Alert variant="neutral" actions={<Button size="sm" variant="outline" onClick={() => void alerts.refetch()}>{tc('common.retry')}</Button>}>
        {t('loadFailed')}: {errorMessage(alerts.error, tc)}
      </Alert>
    );
  }
  const items = alerts.data.items;
  if (items.length === 0) return null;

  async function onDismiss(id: string) {
    setBusy(id);
    try {
      await dismiss.mutateAsync({ params: { id } });
      await queryClient.invalidateQueries({ queryKey: ['listActiveAlerts'] });
    } catch (e) {
      // The alert stays; the next attempt is one click away.
      void e;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      {items.map((alert) => {
        const view = describe(alert, t);
        return (
          <Alert
            key={alert.id}
            variant={view.variant}
            title={view.title}
            actions={
              <>
                {view.href ? (
                  <Button size="sm" asChild>
                    <Link href={view.href}>{view.cta}</Link>
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" loading={busy === alert.id} onClick={() => void onDismiss(alert.id)}>
                  {tc('shell.dismiss')}
                </Button>
              </>
            }
          >
            {view.body}
          </Alert>
        );
      })}
    </div>
  );
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

function describe(alert: AlertResponse, t: Translate): { variant: 'danger' | 'warning' | 'info'; title: string; body: string; href: string | null; cta: string } {
  const meta = (alert.meta ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (alert.type) {
    case 'low_balance': {
      const balance = num(meta.balance);
      const out = (balance ?? 1) <= 0;
      return {
        variant: out ? 'danger' : 'warning',
        title: out ? t('lowBalance.outTitle') : t('lowBalance.title', { pct: alert.threshold ?? 0 }),
        body: out ? t('lowBalance.outBody') : t('lowBalance.body', { balance: formatCreditsValue(balance ?? 0) }),
        href: routes.app.wallet,
        cta: t('lowBalance.cta'),
      };
    }
    case 'rental_overdue':
      return {
        variant: 'warning',
        title: t('rentalOverdue.title', { number: formatPhone(typeof meta.e164 === 'string' ? meta.e164 : null) }),
        body: t('rentalOverdue.body', { days: num(meta.days_overdue) ?? alert.threshold ?? 0 }),
        href: routes.app.wallet,
        cta: t('lowBalance.cta'),
      };
    case 'number_released':
      return {
        variant: 'danger',
        title: t('numberReleased.title', { number: formatPhone(typeof meta.e164 === 'string' ? meta.e164 : null) }),
        body: t('numberReleased.body'),
        href: routes.app.numbers,
        cta: t('numberReleased.cta'),
      };
    case 'concurrency':
      return {
        variant: 'warning',
        title: t('concurrency.title'),
        body: t('concurrency.body', { live: num(meta.live) ?? alert.threshold ?? 0, cap: num(meta.cap) ?? 0 }),
        href: routes.app.wallet,
        cta: t('concurrency.cta'),
      };
    case 'auto_topup_failed':
    default:
      return {
        variant: 'danger',
        title: t('autoTopupFailed.title'),
        body: t('autoTopupFailed.body'),
        href: routes.app.wallet,
        cta: t('autoTopupFailed.cta'),
      };
  }
}
