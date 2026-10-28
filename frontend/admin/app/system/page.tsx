'use client';

import { useAdminListJobs, useAdminListWebhookEvents, useAdminSystemHealth, useApi } from '@portal/api-client';
import { jobStatus, type JobStatus } from '@portal/schemas';
import { Input, Skeleton, Tabs, TabsList, TabsTrigger } from '@portal/ui';
import * as React from 'react';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { FilterBar, FilterSelect, SearchBox } from '@/src/components/common/filter-bar';
import { Pager } from '@/src/components/common/pager';
import { LoadError, QueryList } from '@/src/components/common/query-states';
import { DiagnosticsCard } from '@/src/components/system/diagnostics-card';
import { FlagsTab } from '@/src/components/system/flags-tab';
import { HealthCards } from '@/src/components/system/health-cards';
import { JobSheet, JobsTable } from '@/src/components/system/jobs-table';
import { WebhookSheet, WebhooksTable } from '@/src/components/system/webhooks-table';
import { humanize } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useDebouncedValue } from '@/src/lib/use-debounced';
import { pickParam, setParam, useUrlQuery } from '@/src/lib/use-url-query';
import { SYSTEM_TABS } from '@/src/routes';

const LIMIT = 50;
const PROVIDERS = ['retell', 'stripe', 'auth'] as const;
const WH_STATUSES = ['processed', 'pending', 'failed'] as const;

export default function SystemPage() {
  return (
    <AdminShell>
      <System />
    </AdminShell>
  );
}

type Setter = (update: (next: URLSearchParams) => void, mode?: 'push' | 'replace') => void;

function System() {
  const [params, setQuery] = useUrlQuery();
  const tab = pickParam(params, 'tab', SYSTEM_TABS, 'health');
  const id = params.get('id');
  const close = () => setQuery((n) => setParam(n, 'id', null), 'replace');
  return (
    <>
      <PageHeader title="System" crumbs={[{ label: 'System' }]} description="Health, queues, webhooks, flags and kill switches." />
      <Tabs value={tab} onValueChange={(v) => setQuery((n) => { setParam(n, 'tab', v === 'health' ? null : v); setParam(n, 'id', null); setParam(n, 'status', null); setParam(n, 'q', null); })}>
        <TabsList>
          <TabsTrigger value="health">Health</TabsTrigger>
          <TabsTrigger value="jobs">Jobs</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          <TabsTrigger value="flags">Flags</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'health' ? <HealthTab /> : null}
      {tab === 'jobs' ? (
        <>
          <JobsTab params={params} setQuery={setQuery} />
          <JobSheet id={id} onClose={close} />
        </>
      ) : null}
      {tab === 'webhooks' ? (
        <>
          <WebhooksTab params={params} setQuery={setQuery} />
          <WebhookSheet id={id} onClose={close} />
        </>
      ) : null}
      {tab === 'flags' ? <FlagsTab /> : null}
    </>
  );
}

function HealthTab() {
  const api = useApi();
  const health = useAdminSystemHealth(api, { refetchInterval: 30_000, staleTime: 15_000 });
  if (health.isPending) return <Skeleton className="h-64" aria-busy />;
  if (health.isError) return <LoadError error={health.error} onRetry={() => void health.refetch()} />;
  return (
    <div className="space-y-4">
      <HealthCards h={health.data} />
      <DiagnosticsCard />
    </div>
  );
}

function JobsTab({ params, setQuery }: { params: URLSearchParams; setQuery: Setter }) {
  const api = useApi();
  const pager = useCursorPager();
  const status = pickParam(params, 'status', jobStatus.options, '' as JobStatus | '') || undefined;
  const [type, setType] = React.useState(params.get('type') ?? '');
  const debouncedType = useDebouncedValue(type.trim(), 300);
  const tenantId = params.get('tenant_id') || undefined;
  React.useEffect(() => {
    setQuery((n) => setParam(n, 'type', debouncedType), 'replace');
  }, [debouncedType, setQuery]);
  const { reset } = pager;
  React.useEffect(() => reset(), [status, debouncedType, tenantId, reset]);
  const list = useAdminListJobs(api, { status, type: debouncedType || undefined, tenant_id: tenantId, cursor: pager.cursor, limit: LIMIT }, { refetchInterval: 15_000 });
  return (
    <>
      <FilterBar>
        <FilterSelect label="Status" value={status} onChange={(v) => setQuery((n) => setParam(n, 'status', v))} options={jobStatus.options.map((s) => ({ value: s, label: humanize(s) }))} />
        <Input value={type} onChange={(e) => setType(e.target.value)} placeholder="Type, e.g. activate-agent" className="w-full sm:w-60" aria-label="Job type" />
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No jobs match' }}>
        {(rows) => <JobsTable rows={rows} onOpen={(id) => setQuery((n) => setParam(n, 'id', id), 'replace')} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
    </>
  );
}

function WebhooksTab({ params, setQuery }: { params: URLSearchParams; setQuery: Setter }) {
  const api = useApi();
  const pager = useCursorPager();
  const provider = pickParam(params, 'provider', PROVIDERS, '' as (typeof PROVIDERS)[number] | '') || undefined;
  const status = pickParam(params, 'status', WH_STATUSES, '' as (typeof WH_STATUSES)[number] | '') || undefined;
  const [q, setQ] = React.useState(params.get('q') ?? '');
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const tenantId = params.get('tenant_id') || undefined;
  React.useEffect(() => {
    setQuery((n) => setParam(n, 'q', debouncedQ), 'replace');
  }, [debouncedQ, setQuery]);
  const { reset } = pager;
  React.useEffect(() => reset(), [provider, status, debouncedQ, tenantId, reset]);
  const list = useAdminListWebhookEvents(api, { provider, status, q: debouncedQ || undefined, tenant_id: tenantId, cursor: pager.cursor, limit: LIMIT }, { refetchInterval: 15_000 });
  return (
    <>
      <FilterBar>
        <FilterSelect label="Provider" value={provider} onChange={(v) => setQuery((n) => setParam(n, 'provider', v))} options={[{ value: 'retell', label: 'Voice platform' }, { value: 'stripe', label: 'Stripe' }, { value: 'auth', label: 'Auth' }]} />
        <FilterSelect label="Status" value={status} onChange={(v) => setQuery((n) => setParam(n, 'status', v))} options={WH_STATUSES.map((s) => ({ value: s, label: humanize(s) }))} />
        <SearchBox value={q} onChange={setQ} placeholder="External id, event type…" />
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No webhook events match' }}>
        {(rows) => <WebhooksTable rows={rows} onOpen={(id) => setQuery((n) => setParam(n, 'id', id), 'replace')} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
    </>
  );
}
