'use client';

import { useAdminListFailedTopups, useAdminListPurchases, useApi } from '@portal/api-client';
import { purchaseStatus, type AdminRange, type PurchaseStatus } from '@portal/schemas';
import { Input, Tabs, TabsList, TabsTrigger, cn } from '@portal/ui';
import * as React from 'react';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { FailedTopupsTable } from '@/src/components/billing/failed-topups-table';
import { PurchaseSheet, PurchasesTable } from '@/src/components/billing/purchases-table';
import { BreakageTab, CogsTab, DeferredTab } from '@/src/components/billing/reports-tabs';
import { RevenueTab } from '@/src/components/billing/revenue-tab';
import { FilterBar, FilterSelect, SearchBox } from '@/src/components/common/filter-bar';
import { Pager } from '@/src/components/common/pager';
import { QueryList } from '@/src/components/common/query-states';
import { humanize } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useDebouncedValue } from '@/src/lib/use-debounced';
import { pickParam, setParam, useUrlQuery } from '@/src/lib/use-url-query';
import { BILLING_TABS } from '@/src/routes';

const LIMIT = 50;
const RANGES: AdminRange[] = ['7d', '30d', '90d'];
const TOPUP_FILTER = ['true', 'false'] as const;

export default function BillingPage() {
  return (
    <AdminShell>
      <Billing />
    </AdminShell>
  );
}

type Setter = (update: (next: URLSearchParams) => void, mode?: 'push' | 'replace') => void;

/** SA9 Billing & finance: `/billing/?tab=&id=` — purchases (with refunds), failed auto top-ups, the revenue report. */
function Billing() {
  const [params, setQuery] = useUrlQuery();
  const tab = pickParam(params, 'tab', BILLING_TABS, 'purchases');
  const id = params.get('id');
  const range = pickParam(params, 'range', RANGES, '30d');
  const close = () => setQuery((n) => setParam(n, 'id', null), 'replace');
  return (
    <>
      <PageHeader
        title="Billing"
        crumbs={[{ label: 'Billing' }]}
        description="Purchases, refunds, failed auto top-ups and the finance reports."
        actions={
          tab === 'revenue' || tab === 'cogs' || tab === 'breakage' ? (
            <div role="tablist" aria-label="Range" className="inline-flex rounded-md border border-border bg-muted p-0.5 text-xs">
              {RANGES.map((r) => (
                <button key={r} type="button" role="tab" aria-selected={range === r} onClick={() => setQuery((q) => setParam(q, 'range', r === '30d' ? null : r), 'replace')} className={cn('rounded px-3 py-1.5 font-medium transition-colors', range === r ? 'bg-card text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground')}>
                  {r}
                </button>
              ))}
            </div>
          ) : undefined
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) =>
          setQuery((n) => {
            setParam(n, 'tab', v === 'purchases' ? null : v);
            for (const key of ['id', 'q', 'status', 'auto', 'from', 'to']) setParam(n, key, null);
          })
        }
      >
        <TabsList>
          <TabsTrigger value="purchases">Purchases</TabsTrigger>
          <TabsTrigger value="topups">Failed top-ups</TabsTrigger>
          <TabsTrigger value="revenue">Revenue</TabsTrigger>
          <TabsTrigger value="cogs">COGS</TabsTrigger>
          <TabsTrigger value="deferred">Deferred</TabsTrigger>
          <TabsTrigger value="breakage">Breakage</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'purchases' ? (
        <>
          <PurchasesTab params={params} setQuery={setQuery} />
          <PurchaseSheet id={id} onClose={close} />
        </>
      ) : null}
      {tab === 'topups' ? <TopupsTab params={params} /> : null}
      {tab === 'revenue' ? <RevenueTab range={range} /> : null}
      {tab === 'cogs' ? <CogsTab range={range} /> : null}
      {tab === 'deferred' ? <DeferredTab /> : null}
      {tab === 'breakage' ? <BreakageTab range={range} /> : null}
    </>
  );
}

function PurchasesTab({ params, setQuery }: { params: URLSearchParams; setQuery: Setter }) {
  const api = useApi();
  const pager = useCursorPager();
  const status = pickParam(params, 'status', purchaseStatus.options, '' as PurchaseStatus | '') || undefined;
  const auto = pickParam(params, 'auto', TOPUP_FILTER, '' as (typeof TOPUP_FILTER)[number] | '') || undefined;
  const tenantId = params.get('tenant_id') || undefined;
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const [q, setQ] = React.useState(params.get('q') ?? '');
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  React.useEffect(() => {
    setQuery((n) => setParam(n, 'q', debouncedQ), 'replace');
  }, [debouncedQ, setQuery]);
  const { reset } = pager;
  React.useEffect(() => reset(), [status, auto, tenantId, from, to, debouncedQ, reset]);
  // Date inputs are calendar days; the API takes instants, so a day runs from its first to its last millisecond, in the staff member's zone.
  const fromIso = from ? new Date(`${from}T00:00:00`).toISOString() : undefined;
  const toIso = to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined;
  const list = useAdminListPurchases(api, { q: debouncedQ || undefined, status, is_auto_topup: auto, tenant_id: tenantId, from: fromIso, to: toIso, cursor: pager.cursor, limit: LIMIT }, { refetchInterval: 30_000 });
  return (
    <>
      <FilterBar>
        <SearchBox value={q} onChange={setQ} placeholder="Customer, purchase id, session or payment id…" />
        <FilterSelect label="Status" value={status} onChange={(v) => setQuery((n) => setParam(n, 'status', v))} options={purchaseStatus.options.map((s) => ({ value: s, label: humanize(s) }))} />
        <FilterSelect label="Auto top-up" allLabel="All purchases" value={auto} onChange={(v) => setQuery((n) => setParam(n, 'auto', v))} options={[{ value: 'true', label: 'Auto top-ups only' }, { value: 'false', label: 'Packs only' }]} />
        <Input type="date" value={from} max={to || undefined} onChange={(e) => setQuery((n) => setParam(n, 'from', e.target.value), 'replace')} className="w-auto" aria-label="From date" />
        <span className="text-xs text-muted-foreground">to</span>
        <Input type="date" value={to} min={from || undefined} onChange={(e) => setQuery((n) => setParam(n, 'to', e.target.value), 'replace')} className="w-auto" aria-label="To date" />
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No purchases match' }}>
        {(rows) => <PurchasesTable rows={rows} onOpen={(purchaseId) => setQuery((n) => setParam(n, 'id', purchaseId), 'replace')} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
    </>
  );
}

function TopupsTab({ params }: { params: URLSearchParams }) {
  const api = useApi();
  const pager = useCursorPager();
  const tenantId = params.get('tenant_id') || undefined;
  const { reset } = pager;
  React.useEffect(() => reset(), [tenantId, reset]);
  const list = useAdminListFailedTopups(api, { tenant_id: tenantId, cursor: pager.cursor, limit: LIMIT }, { refetchInterval: 30_000 });
  return (
    <>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No failed auto top-ups', description: 'Declined cards and top-ups Stripe never confirmed show up here.' }}>
        {(rows) => <FailedTopupsTable rows={rows} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
    </>
  );
}
