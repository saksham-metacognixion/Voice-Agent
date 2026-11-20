'use client';

import { useAdminPricingFx, useAdminRefreshFx, useApi } from '@portal/api-client';
import type { AdminFxResponse } from '@portal/schemas';
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { PermissionButton } from '@/src/components/common/permission-button';
import { Fact, FactGrid, LoadError } from '@/src/components/common/query-states';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { formatCents, formatCredits, formatDate, formatDateTime } from '@/src/lib/format';
import { systemPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

type Pack = AdminFxResponse['packs'][number];
type Rate = AdminFxResponse['history'][number];

const SOURCE_NAME: Record<string, string> = { bank_of_canada: 'Bank of Canada' };
const ROUNDING_MODE: Record<string, string> = { nearest: 'to the nearest', up: 'up to the next', down: 'down to the last' };

/** "to the nearest CA$1.00": the rounding rule in the words of the setting, not a rule of this screen's own. */
function roundingText(fx: AdminFxResponse): string {
  const { step_cents, mode } = fx.settings.rounding;
  return `${ROUNDING_MODE[mode] ?? mode} ${formatCents(step_cents, fx.quote_currency)}`;
}

/**
 * SA5 Currencies (ADR 0049): what a pack costs in each currency and why. Packs are
 * published in USD; the CAD price is that figure at the exchange rate in force, rounded
 * by the configured rule. This tab shows both prices, the rate, when it was last read
 * successfully and how conversion is set up, and lets finance ask for the rate now.
 */
export function CurrenciesTab() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const q = useAdminPricingFx(api, { staleTime: 30_000 });
  const refresh = useAdminRefreshFx(api);
  const [asking, setAsking] = React.useState(false);

  if (q.isPending) return <Skeleton className="h-64" aria-busy />;
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  const fx = q.data;
  const rate = fx.in_force;

  const packColumns: Array<DataColumn<Pack>> = [
    { key: 'pack', header: 'Pack', cell: (p) => <span className="flex items-center gap-2 font-medium">{p.name}{p.active ? null : <Badge variant="outline">not on sale</Badge>}</span> },
    { key: 'credits', header: 'Credits', align: 'right', cell: (p) => <span className="tabular-nums">{formatCredits(p.credits)}</span> },
    { key: 'base', header: `${fx.base_currency} (published)`, align: 'right', cell: (p) => <span className="tabular-nums">{formatCents(p.base_price_cents, p.base_currency)}</span> },
    {
      key: 'derived',
      header: `${fx.quote_currency} (derived)`,
      align: 'right',
      cell: (p) => (p.derived_price_cents === null ? <span className="text-muted-foreground">No price</span> : <span className="tabular-nums font-medium">{formatCents(p.derived_price_cents, fx.quote_currency)}</span>),
    },
  ];
  const historyColumns: Array<DataColumn<Rate>> = [
    { key: 'day', header: 'Business day', cell: (r) => <span className="whitespace-nowrap">{formatDate(`${r.observed_on}T12:00:00Z`)}</span> },
    { key: 'rate', header: `1 ${fx.base_currency} in ${fx.quote_currency}`, align: 'right', cell: (r) => <span className="tabular-nums font-medium">{r.rate}</span> },
    { key: 'source', header: 'Source', cell: (r) => `${SOURCE_NAME[r.source] ?? r.source} · ${r.series}` },
    { key: 'fetched', header: 'First stored', cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.fetched_at)}</span> },
  ];

  return (
    <div className="flex flex-col gap-6">
      {rate === null ? (
        <Alert variant="danger" title={`No ${fx.base_currency}/${fx.quote_currency} rate is stored`}>
          Nothing can be priced or bought in {fx.quote_currency} until a refresh succeeds. {fx.base_currency} purchases are not affected.
        </Alert>
      ) : rate.stale ? (
        <Alert variant="warning" title={`The rate in force is ${rate.age_days} days old`}>
          It is still used for {fx.quote_currency} prices. The source has not published a newer business day, or the refresh is failing: check the ops alerts.
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">Exchange rate in force</CardTitle>
            <CardDescription className="text-xs">
              {fx.quote_currency} prices are the published {fx.base_currency} prices at this rate, rounded {roundingText(fx)}. A purchase keeps the rate it was made at.
            </CardDescription>
          </div>
          <PermissionButton size="sm" variant="outline" denied={can.refreshFx()} onClick={() => setAsking(true)}>
            Refresh now
          </PermissionButton>
        </CardHeader>
        <CardContent>
          <FactGrid>
            <Fact label={`1 ${fx.base_currency} in ${fx.quote_currency}`}>{rate ? <span className="tabular-nums">{rate.rate}</span> : 'None stored'}</Fact>
            <Fact label="Business day">{rate ? formatDate(`${rate.observed_on}T12:00:00Z`) : '–'}</Fact>
            <Fact label="Source">{rate ? `${SOURCE_NAME[rate.source] ?? rate.source} · ${rate.series}` : (SOURCE_NAME[fx.settings.fx_source] ?? fx.settings.fx_source)}</Fact>
            <Fact label="Last successful refresh">{fx.last_refresh_at ? formatDateTime(fx.last_refresh_at) : 'Never'}</Fact>
            <Fact label="Next refresh due">{fx.next_refresh_due_at ? formatDateTime(fx.next_refresh_due_at) : 'At the next hourly check'}</Fact>
            <Fact label="Refresh interval">{fx.settings.fx_refresh_interval_hours} h</Fact>
            <Fact label={`${fx.quote_currency} rounding`} wrap>{roundingText(fx)}</Fact>
            <Fact label="Stale after">{fx.settings.fx_stale_after_days} days</Fact>
          </FactGrid>
          <p className="mt-4 text-xs text-muted-foreground">
            The interval, the rounding rule and the staleness limit are platform settings: <Link className="text-foreground underline" href={systemPath('settings')}>System, Settings</Link>.
          </p>
        </CardContent>
      </Card>

      <section className="flex flex-col gap-2" aria-labelledby="fx-packs">
        <h2 id="fx-packs" className="text-sm font-medium">Pack prices, pricing v{fx.pricing_version}</h2>
        <DataTable rows={fx.packs} columns={packColumns} rowKey={(p) => p.pack_id} label="Pack prices by currency" />
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="fx-history">
        <h2 id="fx-history" className="text-sm font-medium">Rate history</h2>
        {fx.history.length ? (
          <DataTable rows={fx.history} columns={historyColumns} rowKey={(r) => r.id} label="Stored exchange rates, newest first" />
        ) : (
          <p className="text-sm text-muted-foreground">No rate has been stored yet. The worker asks for one when it starts and every hour after.</p>
        )}
      </section>

      <StaffActionDialog
        open={asking}
        onOpenChange={setAsking}
        title="Refresh the exchange rate now"
        description="Asks the source for its latest published rate, outside the hourly check."
        consequences={[
          `A newer business day becomes the rate in force, and every ${fx.quote_currency} price follows it at once.`,
          'If the source cannot be read, or its figure is implausibly far from the stored one, nothing changes and ops is alerted.',
        ]}
        confirmLabel="Refresh"
        onConfirm={async (body) => {
          const result = await refresh.mutateAsync({ body });
          queryClient.setQueryData(['adminPricingFx'], result.fx);
          if (result.outcome === 'failed') toast.error('The rate was not refreshed', { description: result.error ?? undefined });
          else toast.success(result.outcome === 'stored' ? `New rate in force: ${result.fx.in_force?.rate ?? ''}` : 'No newer rate published', { description: result.outcome === 'unchanged' ? 'The rate in force is still the latest business day.' : undefined });
        }}
      />
    </div>
  );
}
