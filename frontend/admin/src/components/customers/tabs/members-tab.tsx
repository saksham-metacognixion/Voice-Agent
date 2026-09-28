'use client';

import { useAdminCustomerMembers, useApi } from '@portal/api-client';
import type { AdminMemberResponse } from '@portal/schemas';
import { Badge } from '@portal/ui';
import { useRouter } from 'next/navigation';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { QueryList } from '@/src/components/common/query-states';
import { YesNo } from '@/src/components/common/status-badges';
import { formatDate } from '@/src/lib/format';
import { userPath } from '@/src/routes';

export function MembersTab({ customerId }: { customerId: string }) {
  const api = useApi();
  const router = useRouter();
  const members = useAdminCustomerMembers(api, { id: customerId });
  const columns: Array<DataColumn<AdminMemberResponse>> = [
    { key: 'email', header: 'Member', cell: (r) => <span className="flex flex-col"><span className="font-medium">{r.email}</span>{r.name ? <span className="text-xs text-muted-foreground">{r.name}</span> : null}</span> },
    { key: 'role', header: 'Role', cell: (r) => <Badge variant={r.role === 'owner' ? 'primary' : 'outline'}>{r.role}</Badge> },
    { key: 'mfa', header: 'MFA', cell: (r) => <YesNo value={r.mfa_enabled} yes="Enrolled" no="None" /> },
    { key: 'locked', header: 'Locked', cell: (r) => (r.locked_at ? <Badge variant="danger">Locked</Badge> : <span className="text-muted-foreground">–</span>) },
    { key: 'joined', header: 'Joined', cell: (r) => formatDate(r.joined_at) },
  ];
  return (
    <QueryList query={members} rows={members.data} empty={{ title: 'No members' }}>
      {(rows) => <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Members" onRowClick={(r) => router.push(userPath(r.user_id))} />}
    </QueryList>
  );
}
