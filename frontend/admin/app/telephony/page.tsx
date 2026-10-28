'use client';

import { useAdminListAgents, useAdminListNumbers, useApi } from '@portal/api-client';
import { agentStatus, phoneNumberStatus, type AgentStatus, type PhoneNumberStatus } from '@portal/schemas';
import { Tabs, TabsList, TabsTrigger } from '@portal/ui';
import * as React from 'react';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { FilterBar, FilterSelect, SearchBox } from '@/src/components/common/filter-bar';
import { Pager } from '@/src/components/common/pager';
import { QueryList } from '@/src/components/common/query-states';
import { AgentsTable } from '@/src/components/telephony/agents-table';
import { ConcurrencyTab } from '@/src/components/telephony/concurrency-tab';
import { AgentSheet, NumberSheet } from '@/src/components/telephony/detail-panels';
import { NumbersTable } from '@/src/components/telephony/numbers-table';
import { ProvisioningTab } from '@/src/components/telephony/provisioning-tab';
import { humanize } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useDebouncedValue } from '@/src/lib/use-debounced';
import { pickParam, setParam, useUrlQuery } from '@/src/lib/use-url-query';
import { TELEPHONY_TABS } from '@/src/routes';

const LIMIT = 25;

export default function TelephonyPage() {
  return (
    <AdminShell>
      <Telephony />
    </AdminShell>
  );
}

function Telephony() {
  const [params, setQuery] = useUrlQuery();
  const tab = pickParam(params, 'tab', TELEPHONY_TABS, 'numbers');
  const id = params.get('id');
  const close = () => setQuery((n) => setParam(n, 'id', null), 'replace');
  return (
    <>
      <PageHeader title="Telephony" crumbs={[{ label: 'Telephony' }]} description="Numbers, agents, the provisioning queue and live concurrency across every workspace." />
      <Tabs value={tab} onValueChange={(v) => setQuery((n) => { setParam(n, 'tab', v === 'numbers' ? null : v); setParam(n, 'id', null); setParam(n, 'status', null); setParam(n, 'q', null); setParam(n, 'overdue', null); })}>
        <TabsList>
          <TabsTrigger value="numbers">Numbers</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="provisioning">Provisioning</TabsTrigger>
          <TabsTrigger value="concurrency">Concurrency</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'numbers' ? (
        <>
          <NumbersTab params={params} setQuery={setQuery} />
          <NumberSheet id={id} onClose={close} />
        </>
      ) : null}
      {tab === 'agents' ? (
        <>
          <AgentsTab params={params} setQuery={setQuery} />
          <AgentSheet id={id} onClose={close} />
        </>
      ) : null}
      {tab === 'provisioning' ? <ProvisioningTab params={params} setQuery={setQuery} /> : null}
      {tab === 'concurrency' ? <ConcurrencyTab /> : null}
    </>
  );
}

type Setter = (update: (next: URLSearchParams) => void, mode?: 'push' | 'replace') => void;

function NumbersTab({ params, setQuery }: { params: URLSearchParams; setQuery: Setter }) {
  const api = useApi();
  const pager = useCursorPager();
  const [q, setQ] = React.useState(params.get('q') ?? '');
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const status = pickParam(params, 'status', phoneNumberStatus.options, '' as PhoneNumberStatus | '') || undefined;
  const tenantId = params.get('tenant_id') || undefined;
  const overdue = params.get('overdue') === 'true' ? 'true' : undefined;
  React.useEffect(() => {
    setQuery((n) => setParam(n, 'q', debouncedQ), 'replace');
  }, [debouncedQ, setQuery]);
  const { reset } = pager;
  React.useEffect(() => reset(), [debouncedQ, status, tenantId, overdue, reset]);
  const list = useAdminListNumbers(api, { q: debouncedQ || undefined, status, tenant_id: tenantId, rental_overdue: overdue, cursor: pager.cursor, limit: LIMIT });
  return (
    <>
      <FilterBar>
        <SearchBox value={q} onChange={setQ} placeholder="E.164, customer, agent…" />
        <FilterSelect label="Status" value={status} onChange={(v) => setQuery((n) => setParam(n, 'status', v))} options={phoneNumberStatus.options.map((s) => ({ value: s, label: humanize(s) }))} />
        <FilterSelect label="Rental" allLabel="Any rental" value={overdue} onChange={(v) => setQuery((n) => setParam(n, 'overdue', v))} options={[{ value: 'true', label: 'Rental overdue' }]} />
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No numbers match' }}>
        {(rows) => <NumbersTable rows={rows} onOpen={(id) => setQuery((n) => setParam(n, 'id', id), 'replace')} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
    </>
  );
}

function AgentsTab({ params, setQuery }: { params: URLSearchParams; setQuery: Setter }) {
  const api = useApi();
  const pager = useCursorPager();
  const [q, setQ] = React.useState(params.get('q') ?? '');
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const status = pickParam(params, 'status', agentStatus.options, '' as AgentStatus | '') || undefined;
  const tenantId = params.get('tenant_id') || undefined;
  React.useEffect(() => {
    setQuery((n) => setParam(n, 'q', debouncedQ), 'replace');
  }, [debouncedQ, setQuery]);
  const { reset } = pager;
  React.useEffect(() => reset(), [debouncedQ, status, tenantId, reset]);
  const list = useAdminListAgents(api, { q: debouncedQ || undefined, status, tenant_id: tenantId, cursor: pager.cursor, limit: LIMIT });
  return (
    <>
      <FilterBar>
        <SearchBox value={q} onChange={setQ} placeholder="Agent name, customer…" />
        <FilterSelect label="Status" value={status} onChange={(v) => setQuery((n) => setParam(n, 'status', v))} options={agentStatus.options.map((s) => ({ value: s, label: humanize(s) }))} />
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No agents match' }}>
        {(rows) => <AgentsTable rows={rows} onOpen={(id) => setQuery((n) => setParam(n, 'id', id), 'replace')} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
    </>
  );
}
