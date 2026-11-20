'use client';

import { useAdminPauseAgent, useAdminResumeAgent, useApi } from '@portal/api-client';
import type { AdminAgentResponse, StaffActionRequest } from '@portal/schemas';
import { toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { CellActions, DataTable, type DataColumn } from '@/src/components/common/data-table';
import { PermissionButton } from '@/src/components/common/permission-button';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { AgentStatusBadge, TierBadge } from '@/src/components/common/status-badges';
import { formatDate, formatNumber, formatPhone } from '@/src/lib/format';
import { customerPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

/** Agents across workspaces (Telephony) or one customer's (SA2 Agents tab). Pause/Resume via the reason dialog. */
export function AgentsTable({ rows, showCustomer = true, onOpen }: { rows: AdminAgentResponse[]; showCustomer?: boolean; onOpen?: (id: string) => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const pause = useAdminPauseAgent(api);
  const resume = useAdminResumeAgent(api);
  const [target, setTarget] = React.useState<{ agent: AdminAgentResponse; action: 'pause' | 'resume' } | null>(null);
  const denied = can.pauseAgentOrNumber();

  async function run(body: StaffActionRequest) {
    if (!target) return;
    const vars = { params: { id: target.agent.id }, body };
    if (target.action === 'pause') await pause.mutateAsync(vars);
    else await resume.mutateAsync(vars);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['adminListAgents'] }),
      queryClient.invalidateQueries({ queryKey: ['adminCustomerAgents'] }),
      queryClient.invalidateQueries({ queryKey: ['adminGetAgent'] }),
      queryClient.invalidateQueries({ queryKey: ['adminGetCustomer'] }),
    ]);
    toast.success(target.action === 'pause' ? `${target.agent.name} paused` : `${target.agent.name} resumed`);
  }

  const columns: Array<DataColumn<AdminAgentResponse>> = [
    {
      key: 'name',
      header: 'Agent',
      cell: (r) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{r.name}</span>
          <span className="text-xs text-muted-foreground">{[r.template_id, r.industry].filter(Boolean).join(' · ') || '–'}</span>
        </div>
      ),
    },
    ...(showCustomer
      ? [
          {
            key: 'customer',
            header: 'Customer',
            cell: (r: AdminAgentResponse) => (
              <Link href={customerPath(r.tenant_id, 'agents')} onClick={(e) => e.stopPropagation()} className="hover:text-primary">
                {r.tenant_name}
              </Link>
            ),
          },
        ]
      : []),
    { key: 'tier', header: 'Tier', cell: (r) => <TierBadge tier={r.tier} /> },
    { key: 'status', header: 'Status', cell: (r) => (r.deleted_at ? <span className="text-muted-foreground">Deleted</span> : <AgentStatusBadge status={r.status} />) },
    { key: 'versions', header: 'Versions', cell: (r) => <span className="tabular-nums">{r.published_version ? `v${r.published_version} live` : 'unpublished'}{r.draft_version ? ` · draft v${r.draft_version}` : ''}</span> },
    { key: 'numbers', header: 'Numbers', cell: (r) => (r.numbers.length ? r.numbers.map((n) => formatPhone(n.e164) + (n.status !== 'active' ? ` (${n.status})` : '')).join(', ') : <span className="text-muted-foreground">–</span>) },
    { key: 'kb', header: 'KB sources', align: 'right', cell: (r) => formatNumber(r.knowledge_sources, 0) },
    { key: 'calls', header: 'Calls 7d', align: 'right', cell: (r) => formatNumber(r.calls_7d, 0) },
    { key: 'created', header: 'Created', cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{formatDate(r.created_at)}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <CellActions>
          {r.deleted_at ? null : r.status === 'paused' ? (
            <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setTarget({ agent: r, action: 'resume' })}>
              Resume
            </PermissionButton>
          ) : r.status === 'live' ? (
            <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setTarget({ agent: r, action: 'pause' })}>
              Pause
            </PermissionButton>
          ) : null}
        </CellActions>
      ),
    },
  ];

  return (
    <>
      <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Agents" onRowClick={onOpen ? (r) => onOpen(r.id) : undefined} />
      <StaffActionDialog
        open={Boolean(target)}
        onOpenChange={(o) => (o ? undefined : setTarget(null))}
        title={target?.action === 'pause' ? `Pause ${target.agent.name}` : `Resume ${target?.agent.name ?? 'agent'}`}
        description={target ? `${target.agent.tenant_name} · ${target.agent.tier}` : undefined}
        consequences={target?.action === 'pause' ? ['Every number bound to the agent declines inbound calls.', 'The customer sees the agent as paused and can resume it themselves.', 'The voice platform is not called; drafts and versions are untouched.'] : ['The published version answers calls again on its numbers.']}
        confirmLabel={target?.action === 'pause' ? 'Pause agent' : 'Resume agent'}
        destructive={target?.action === 'pause'}
        onConfirm={run}
      />
    </>
  );
}
