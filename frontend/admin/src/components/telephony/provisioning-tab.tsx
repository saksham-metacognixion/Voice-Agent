'use client';

import { useAdminProvisioning, useAdminRetryProvisioning, useApi } from '@portal/api-client';
import { jobStatus, type AdminProvisioningJob, type JobStatus, type StaffActionRequest } from '@portal/schemas';
import { Badge, Input, Progress, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { CellActions, DataTable, type DataColumn } from '@/src/components/common/data-table';
import { FilterBar, FilterSelect } from '@/src/components/common/filter-bar';
import { Pager } from '@/src/components/common/pager';
import { PermissionButton } from '@/src/components/common/permission-button';
import { QueryList } from '@/src/components/common/query-states';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { JobStatusBadge, NumberStatusBadge } from '@/src/components/common/status-badges';
import { formatDateTime, formatPhone, humanize, relativeTime, shortId } from '@/src/lib/format';
import { useCursorPager } from '@/src/lib/use-cursor-pager';
import { useDebouncedValue } from '@/src/lib/use-debounced';
import { pickParam, setParam } from '@/src/lib/use-url-query';
import { customerPath, systemPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

const LIMIT = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPE_LABEL: Record<string, string> = { 'activate-agent': 'Activation', 'provision-number': 'Number', 'knowledge-sync': 'Knowledge' };

type Setter = (update: (next: URLSearchParams) => void, mode?: 'push' | 'replace') => void;

/** SA7 provisioning queue (D13): every activation, number and knowledge job with its step machine, refreshed every 15 s. */
export function ProvisioningTab({ params, setQuery }: { params: URLSearchParams; setQuery: Setter }) {
  const api = useApi();
  const pager = useCursorPager();
  const status = pickParam(params, 'status', jobStatus.options, '' as JobStatus | '') || undefined;
  const [tenant, setTenant] = React.useState(params.get('tenant_id') ?? '');
  const debouncedTenant = useDebouncedValue(tenant.trim(), 300);
  const tenantId = UUID_RE.test(debouncedTenant) ? debouncedTenant : undefined;
  React.useEffect(() => {
    setQuery((n) => setParam(n, 'tenant_id', tenantId), 'replace');
  }, [tenantId, setQuery]);
  const { reset } = pager;
  React.useEffect(() => reset(), [status, tenantId, reset]);
  const list = useAdminProvisioning(api, { status, tenant_id: tenantId, cursor: pager.cursor, limit: LIMIT }, { refetchInterval: 15_000 });
  return (
    <>
      <FilterBar>
        <FilterSelect label="Status" value={status} onChange={(v) => setQuery((n) => setParam(n, 'status', v))} options={jobStatus.options.map((s) => ({ value: s, label: humanize(s) }))} />
        <Input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="Customer id (uuid)" className="w-full font-mono text-xs sm:w-80" aria-label="Customer id" invalid={Boolean(debouncedTenant) && !tenantId} />
      </FilterBar>
      <QueryList query={list} rows={list.data?.items} empty={{ title: 'Nothing in the provisioning queue', description: status ? `No ${humanize(status).toLowerCase()} jobs match.` : 'Activations, number purchases and knowledge syncs appear here as they run.' }}>
        {(rows) => <ProvisioningTable rows={rows} />}
      </QueryList>
      <Pager page={pager.page} pageSize={LIMIT} count={list.data?.items.length} total={list.data?.total} hasPrevious={pager.hasPrevious} hasNext={Boolean(list.data?.next_cursor)} onPrevious={pager.previous} onNext={() => pager.next(list.data?.next_cursor)} />
    </>
  );
}

function StepCell({ j }: { j: AdminProvisioningJob }) {
  const a = j.activation;
  if (!a) return <span className="text-muted-foreground">–</span>;
  const label = a.status === 'live' ? 'Live' : a.status === 'failed' ? `Failed at ${humanize(a.step ?? 'start').toLowerCase()}` : a.step ? humanize(a.step) : 'Pending';
  return (
    <div className="flex min-w-36 flex-col gap-1">
      <span className={a.status === 'failed' ? 'text-xs text-danger' : 'text-xs'}>
        {label} · {a.progress}%
      </span>
      <Progress value={a.progress} className={a.status === 'failed' ? '[&>div]:bg-danger' : a.status === 'live' ? '[&>div]:bg-success' : undefined} aria-label={`${a.progress}% of activation steps done`} />
    </div>
  );
}

function ProvisioningTable({ rows }: { rows: AdminProvisioningJob[] }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const denied = can.operateQueues();
  const retry = useAdminRetryProvisioning(api);
  const [target, setTarget] = React.useState<AdminProvisioningJob | null>(null);

  async function run(body: StaffActionRequest) {
    if (!target) return;
    await retry.mutateAsync({ params: { jobId: target.id }, body });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['adminProvisioning'] }),
      queryClient.invalidateQueries({ queryKey: ['adminListJobs'] }),
      queryClient.invalidateQueries({ queryKey: ['adminGetJob'] }),
      queryClient.invalidateQueries({ queryKey: ['adminSystemHealth'] }),
    ]);
    toast.success('Job re-enqueued', { description: 'A step machine resumes at its first incomplete step.' });
  }

  const columns: Array<DataColumn<AdminProvisioningJob>> = [
    { key: 'when', header: 'When', cell: (r) => <span className="whitespace-nowrap" title={formatDateTime(r.created_at, { seconds: true })}>{relativeTime(r.created_at)}</span> },
    {
      key: 'customer',
      header: 'Customer',
      cell: (r) =>
        r.tenant ? (
          <Link href={customerPath(r.tenant.id, 'jobs')} className="hover:text-primary">
            {r.tenant.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">–</span>
        ),
    },
    { key: 'agent', header: 'Agent', cell: (r) => r.agent?.name ?? <span className="text-muted-foreground">–</span> },
    {
      key: 'number',
      header: 'Number',
      cell: (r) =>
        r.number ? (
          <span className="flex items-center gap-2 whitespace-nowrap">
            <span className="tabular-nums">{r.number.e164 ? formatPhone(r.number.e164) : <span className="text-muted-foreground">(pending)</span>}</span>
            <NumberStatusBadge status={r.number.status} />
          </span>
        ) : (
          <span className="text-muted-foreground">–</span>
        ),
    },
    { key: 'type', header: 'Type', cell: (r) => <Badge variant="outline">{TYPE_LABEL[r.type] ?? r.type}</Badge> },
    { key: 'step', header: 'Step', cell: (r) => <StepCell j={r} /> },
    { key: 'attempt', header: 'Attempt', align: 'right', cell: (r) => (r.activation ? `${r.activation.attempt}/${r.activation.max_attempts}` : '–') },
    { key: 'status', header: 'Status', cell: (r) => <JobStatusBadge status={r.status} /> },
    { key: 'error', header: 'Error', cell: (r) => (r.activation?.error ? <span className="block max-w-64 truncate text-xs text-danger" title={r.activation.error}>{r.activation.error}</span> : <span className="text-muted-foreground">–</span>) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <CellActions>
          {r.retryable ? (
            <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setTarget(r)}>
              Retry
            </PermissionButton>
          ) : r.status === 'failed' ? (
            <PermissionButton size="sm" variant="outline" denied={r.number ? 'Re-provision the number from its page in Numbers.' : 'This job cannot be re-run from here.'}>
              Retry
            </PermissionButton>
          ) : null}
          <Link href={systemPath('jobs', r.id)} className="text-xs text-muted-foreground hover:text-primary">
            Job {shortId(r.id)}
          </Link>
        </CellActions>
      ),
    },
  ];

  return (
    <>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Provisioning queue" dense />
      <StaffActionDialog
        open={Boolean(target)}
        onOpenChange={(o) => (o ? undefined : setTarget(null))}
        title="Retry job"
        description={target ? `${TYPE_LABEL[target.type] ?? target.type} · ${shortId(target.id)}${target.tenant ? ` · ${target.tenant.name}` : ''}` : undefined}
        consequences={['The job is re-enqueued with the payload it was created with.', 'An activation resumes at its first incomplete step; nothing already done is repeated.']}
        confirmLabel="Retry"
        onConfirm={run}
      />
    </>
  );
}
