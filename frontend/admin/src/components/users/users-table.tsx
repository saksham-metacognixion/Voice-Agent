'use client';

import type { AdminUserResponse } from '@portal/schemas';
import { Badge } from '@portal/ui';
import { useRouter } from 'next/navigation';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { YesNo } from '@/src/components/common/status-badges';
import { formatDate } from '@/src/lib/format';
import { userPath } from '@/src/routes';

export function MembershipChips({ memberships }: { memberships: AdminUserResponse['memberships'] }) {
  if (!memberships.length) return <span className="text-muted-foreground">–</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {memberships.map((m) => (
        <Badge key={m.tenant_id} variant="outline" title={m.tenant_id}>
          {m.tenant_name} · {m.role}
        </Badge>
      ))}
    </span>
  );
}

export function UsersTable({ rows }: { rows: AdminUserResponse[] }) {
  const router = useRouter();
  const columns: Array<DataColumn<AdminUserResponse>> = [
    {
      key: 'email',
      header: 'User',
      cell: (r) => (
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{r.email}</span>
          {r.name ? <span className="truncate text-xs text-muted-foreground">{r.name}</span> : null}
        </div>
      ),
    },
    { key: 'mfa', header: 'MFA', cell: (r) => <YesNo value={r.mfa_enabled} yes="Enrolled" no="None" /> },
    { key: 'locked', header: 'Locked', cell: (r) => (r.locked_at ? <Badge variant="danger">Locked</Badge> : <span className="text-muted-foreground">–</span>) },
    { key: 'memberships', header: 'Workspaces', cell: (r) => <MembershipChips memberships={r.memberships} /> },
    { key: 'created', header: 'Created', cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{formatDate(r.created_at)}</span> },
  ];
  return <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Users" onRowClick={(r) => router.push(userPath(r.id))} />;
}
