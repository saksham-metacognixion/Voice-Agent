'use client';

import { useAdminListReconciliations, useAdminRunReconciliation, useApi } from '@portal/api-client';
import type { AdminReconciliationRun, StaffActionRequest } from '@portal/schemas';
import { Badge, Field, Input, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import * as React from 'react';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { DetailSheet } from '@/src/components/common/detail-sheet';
import { FilterBar, FilterSelect } from '@/src/components/common/filter-bar';
import { Pager } from '@/src/components/common/pager';
import { PermissionButton } from '@/src/components/common/permission-button';
import { Fact, FactGrid, QueryList } from '@/src/components/common/query-states';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { formatDateTime, formatNumber, formatPercent, humanize } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useStaff } from '@/src/staff/staff-provider';

const LIMIT = 30;
const STATUSES = ['ok', 'drift', 'partial', 'provider_error'] as const;
type Status = (typeof STATUSES)[number];

const STATUS_VARIANT: Record<Status, 'success' | 'danger' | 'warning'> = { ok: 'success', drift: 'danger', partial: 'warning', provider_error: 'warning' };
const STATUS_LABEL: Record<Status, string> = { ok: 'Matches', drift: 'Drift', partial: 'Partial', provider_error: 'Platform error' };

function yesterday(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

/**
 * SA12 Reconciliation (admin §9, §14.2): each UTC day of the platform's calls against ours,
 * from the nightly job, plus "Run a day" for one that needs checking now. A missing call is
 * one the platform ran and we never billed; an extra one is ours the platform does not know.
 */
export function ReconciliationTab() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const pager = useCursorPager();
  const [status, setStatus] = React.useState<Status | undefined>();
  const [open, setOpen] = React.useState<AdminReconciliationRun | null>(null);
  const [running, setRunning] = React.useState(false);
  const [day, setDay] = React.useState(yesterday);
  const run = useAdminRunReconciliation(api);
  const { reset } = pager;
  React.useEffect(() => reset(), [status, reset]);
  const list = useAdminListReconciliations(api, { status, cursor: pager.cursor, limit: LIMIT });

  const dayValid = /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= yesterday();
  async function runDay(body: StaffActionRequest) {
    const res = await run.mutateAsync({ body: { ...body, date: day } });
    await queryClient.invalidateQueries({ queryKey: ['adminListReconciliations'] });
    toast.success(`${res.window_start.slice(0, 10)}: ${STATUS_LABEL[res.status]}`, { description: `${formatNumber(res.matched_calls, 0)} matched, ${res.missing_count} missing, ${res.extra_count} extra.` });
    setOpen(res);
  }

  const columns: Array<DataColumn<AdminReconciliationRun>> = [
    { key: 'day', header: 'Day (UTC)', cell: (r) => <span className="whitespace-nowrap tabular-nums">{r.window_start.slice(0, 10)}</span> },
    { key: 'status', header: 'Result', cell: (r) => <Badge variant={STATUS_VARIANT[r.status]}>{STATUS_LABEL[r.status]}</Badge> },
    { key: 'provider', header: 'Platform', align: 'right', cell: (r) => formatNumber(r.provider_calls, 0) },
    { key: 'ours', header: 'Ours', align: 'right', cell: (r) => formatNumber(r.internal_calls, 0) },
    { key: 'missing', header: 'Missing', align: 'right', cell: (r) => (r.missing_count ? <span className="text-danger">{r.missing_count}</span> : '0') },
    { key: 'extra', header: 'Extra', align: 'right', cell: (r) => (r.extra_count ? <span className="text-warning-emphasis">{r.extra_count}</span> : '0') },
    { key: 'drift', header: 'Drift', align: 'right', cell: (r) => <span title={`Alert above ${formatPercent(r.threshold_pct)}`}>{formatPercent(r.drift_pct, 2)}</span> },
    { key: 'alerted', header: 'Alerted', cell: (r) => (r.alerted_at ? formatDateTime(r.alerted_at) : <span className="text-muted-foreground">–</span>) },
    { key: 'updated', header: 'Last run', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.updated_at)}</span> },
  ];

  return (
    <>
      <FilterBar>
        <FilterSelect label="Result" value={status} onChange={(v) => setStatus(v as Status | undefined)} options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
        <PermissionButton size="sm" variant="outline" className="ms-auto" denied={can.operateQueues()} onClick={() => setRunning(true)}>
          <Play /> Run a day
        </PermissionButton>
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'No reconciliation runs yet', description: status ? 'No day has this result.' : 'The nightly job reconciles the previous UTC day at 02:30 UTC.' }}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Reconciliation runs" onRowClick={setOpen} dense />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
      <StaffActionDialog
        open={running}
        onOpenChange={(o) => {
          setRunning(o);
          if (!o) setDay(yesterday());
        }}
        title="Reconcile a day"
        description="Lists the platform's calls for one UTC day and compares them with ours. Running a day again refreshes its row; its alert is still sent at most once."
        confirmLabel="Run"
        extraValid={dayValid}
        onConfirm={runDay}
      >
        <Field id="reconcile-day" label="Day (UTC)" error={dayValid ? undefined : 'Yesterday or earlier.'}>
          <Input id="reconcile-day" type="date" value={day} max={yesterday()} onChange={(e) => setDay(e.target.value)} className="max-w-48" invalid={!dayValid} />
        </Field>
      </StaffActionDialog>
      <DetailSheet open={Boolean(open)} onOpenChange={(o) => (o ? undefined : setOpen(null))} title={open ? `Reconciliation ${open.window_start.slice(0, 10)}` : 'Reconciliation'} description={open ? STATUS_LABEL[open.status] : undefined}>
        {open ? <RunDetail r={open} /> : null}
      </DetailSheet>
    </>
  );
}

function RunDetail({ r }: { r: AdminReconciliationRun }) {
  return (
    <>
      <FactGrid columns={2}>
        <Fact label="Platform calls">{formatNumber(r.provider_calls, 0)}</Fact>
        <Fact label="Our calls">{formatNumber(r.internal_calls, 0)}</Fact>
        <Fact label="Matched">{formatNumber(r.matched_calls, 0)}</Fact>
        <Fact label="Drift">
          {formatPercent(r.drift_pct, 2)} (alert above {formatPercent(r.threshold_pct)})
        </Fact>
        <Fact label="Platform seconds">{formatNumber(r.provider_seconds, 0)}</Fact>
        <Fact label="Our seconds">{formatNumber(r.internal_seconds, 0)}</Fact>
        <Fact label="Alerted">{formatDateTime(r.alerted_at)}</Fact>
        <Fact label="Last run">{formatDateTime(r.updated_at, { seconds: true })}</Fact>
        {r.error ? (
          <Fact label="Error" className="col-span-2" wrap>
            {humanize(r.status)}: {r.error}
          </Fact>
        ) : null}
      </FactGrid>
      <IdList title={`Missing — on the platform, never billed (${r.missing_count})`} ids={r.missing_ids} total={r.missing_count} />
      <IdList title={`Extra — ours, unknown to the platform (${r.extra_count})`} ids={r.extra_ids} total={r.extra_count} />
    </>
  );
}

function IdList({ title, ids, total }: { title: string; ids: string[]; total: number }) {
  if (!total) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="max-h-56 space-y-0.5 overflow-auto rounded-md border border-border p-2 font-mono text-xs">
        {ids.map((id) => (
          <li key={id}>{id}</li>
        ))}
      </ul>
      {total > ids.length ? <p className="mt-1 text-xs text-muted-foreground">First {ids.length} of {total}.</p> : null}
    </div>
  );
}
