'use client';

import { useAdminGetCustomer, useAdminListTickets, useApi } from '@portal/api-client';
import { ticketPriority, ticketStatus, type TicketPriority, type TicketStatus } from '@portal/schemas';
import { Badge, Button, Checkbox, Label } from '@portal/ui';
import { Plus, X } from 'lucide-react';
import * as React from 'react';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { FilterBar, FilterSelect, SearchBox } from '@/src/components/common/filter-bar';
import { Pager } from '@/src/components/common/pager';
import { PermissionButton } from '@/src/components/common/permission-button';
import { QueryList } from '@/src/components/common/query-states';
import { NewTicketDialog } from '@/src/components/support/new-ticket-dialog';
import { TicketSheet } from '@/src/components/support/ticket-sheet';
import { TicketsTable } from '@/src/components/support/tickets-table';
import { humanize } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useDebouncedValue } from '@/src/lib/use-debounced';
import { pickParam, setParam, useUrlQuery } from '@/src/lib/use-url-query';
import { useStaff } from '@/src/staff/staff-provider';

const LIMIT = 25;

export default function SupportPage() {
  return (
    <AdminShell>
      <Support />
    </AdminShell>
  );
}

/**
 * SA4 (D13): the ticket queue. State is the URL — `q`, `status`, `priority`, `mine`,
 * `tenant_id`, the open ticket as `?id=`, and `?new=<tenant_id>` opens the "New ticket"
 * dialog for that customer (SA9 and the Customer 360 link here that way).
 */
function Support() {
  const api = useApi();
  const { can } = useStaff();
  const [params, setQuery] = useUrlQuery();
  const pager = useCursorPager();
  const [q, setQ] = React.useState(params.get('q') ?? '');
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const status = pickParam(params, 'status', ticketStatus.options, '' as TicketStatus | '') || undefined;
  const priority = pickParam(params, 'priority', ticketPriority.options, '' as TicketPriority | '') || undefined;
  const mine = params.get('mine') === '1';
  const tenantId = params.get('tenant_id') || undefined;
  const id = params.get('id');
  const newFor = params.get('new');
  const [creating, setCreating] = React.useState(false);

  React.useEffect(() => {
    setQuery((n) => setParam(n, 'q', debouncedQ), 'replace');
  }, [debouncedQ, setQuery]);
  const { reset } = pager;
  React.useEffect(() => reset(), [debouncedQ, status, priority, mine, tenantId, reset]);

  const list = useAdminListTickets(
    api,
    { q: debouncedQ || undefined, status, priority, tenant_id: tenantId, assignee_staff_id: mine ? 'me' : undefined, cursor: pager.cursor, limit: LIMIT },
    { refetchInterval: 30_000 },
  );
  const scoped = useAdminGetCustomer(api, { id: tenantId ?? '' }, { enabled: Boolean(tenantId) });
  const open = (ticketId: number | string) => setQuery((n) => setParam(n, 'id', String(ticketId)), 'replace');
  const close = () => setQuery((n) => setParam(n, 'id', null), 'replace');
  const closeNew = () => {
    setCreating(false);
    if (newFor) setQuery((n) => setParam(n, 'new', null), 'replace');
  };

  return (
    <>
      <PageHeader
        title="Support"
        crumbs={[{ label: 'Support' }]}
        description="Tickets across every workspace, with the SLA clocks (SA4)."
        actions={
          <PermissionButton size="sm" denied={can.supportTickets()} onClick={() => setCreating(true)}>
            <Plus /> New ticket
          </PermissionButton>
        }
      />
      <FilterBar>
        <SearchBox value={q} onChange={setQ} placeholder="Subject, ticket number, customer…" />
        <FilterSelect label="Status" value={status} onChange={(v) => setQuery((n) => setParam(n, 'status', v))} options={ticketStatus.options.map((s) => ({ value: s, label: humanize(s) }))} />
        <FilterSelect label="Priority" value={priority} onChange={(v) => setQuery((n) => setParam(n, 'priority', v))} options={ticketPriority.options.map((p) => ({ value: p, label: humanize(p) }))} />
        <Label htmlFor="tickets-mine" className="flex items-center gap-2 text-sm">
          <Checkbox id="tickets-mine" checked={mine} onCheckedChange={(v) => setQuery((n) => setParam(n, 'mine', v === true ? '1' : null))} />
          Assigned to me
        </Label>
        {tenantId ? (
          <Badge variant="primary" className="gap-1 pr-1">
            {scoped.data?.name ?? 'One customer'}
            <Button variant="ghost" size="icon-sm" className="size-5" aria-label="Show every customer" onClick={() => setQuery((n) => setParam(n, 'tenant_id', null))}>
              <X className="size-3" />
            </Button>
          </Badge>
        ) : null}
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No tickets match', description: mine ? 'Nothing is assigned to you.' : 'Tickets customers open from their Help page land here.' }}>
        {(rows) => <TicketsTable rows={rows} onOpen={open} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
      <TicketSheet id={id} onClose={close} />
      <NewTicketDialog tenantId={newFor ?? tenantId} open={creating || Boolean(newFor)} onOpenChange={(o) => (o ? setCreating(true) : closeNew())} onCreated={open} />
    </>
  );
}
