'use client';

import { useAdminCustomerMembers, useAdminRemoveMember, useAdminUpdateMember, useApi } from '@portal/api-client';
import { assignableRole, type AdminMemberResponse, type AssignableRole, type StaffActionRequest } from '@portal/schemas';
import { Badge, Field, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { DataTable, type DataColumn } from '@/src/components/common/data-table';
import { PermissionButton } from '@/src/components/common/permission-button';
import { QueryList } from '@/src/components/common/query-states';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { YesNo } from '@/src/components/common/status-badges';
import { formatDate } from '@/src/lib/format';
import { userPath } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

const ROLE_LABELS: Record<AssignableRole, string> = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };
const OWNER_DENIED = 'The owner changes only when they make someone else the owner in the portal.';

/**
 * SA2 Members: who is in the workspace, plus the two staff actions the admin spec lists on
 * `PATCH /admin/customers/:id/members/:mid` — change a role, remove — each with a reason.
 * The owner has neither: ownership moves only by the owner's own transfer.
 */
export function MembersTab({ customerId }: { customerId: string }) {
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const members = useAdminCustomerMembers(api, { id: customerId });
  const update = useAdminUpdateMember(api);
  const remove = useAdminRemoveMember(api);
  const [changing, setChanging] = React.useState<AdminMemberResponse | null>(null);
  const [role, setRole] = React.useState<AssignableRole | ''>('');
  const [removing, setRemoving] = React.useState<AdminMemberResponse | null>(null);

  async function invalidate() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['adminCustomerMembers'] }),
      queryClient.invalidateQueries({ queryKey: ['adminGetCustomer'] }),
      queryClient.invalidateQueries({ queryKey: ['adminCustomerAudit'] }),
    ]);
  }

  async function changeRole(body: StaffActionRequest) {
    if (!changing || !role) return;
    await update.mutateAsync({ params: { id: customerId, mid: changing.id }, body: { ...body, role } });
    await invalidate();
    toast.success(`${changing.email} is now ${ROLE_LABELS[role].toLowerCase()}`);
  }

  async function removeMember(body: StaffActionRequest) {
    if (!removing) return;
    await remove.mutateAsync({ params: { id: customerId, mid: removing.id }, body });
    await invalidate();
    toast.success(`${removing.email} removed`);
  }

  const columns: Array<DataColumn<AdminMemberResponse>> = [
    { key: 'email', header: 'Member', cell: (r) => <span className="flex flex-col"><span className="font-medium">{r.email}</span>{r.name ? <span className="text-xs text-muted-foreground">{r.name}</span> : null}</span> },
    { key: 'role', header: 'Role', cell: (r) => <Badge variant={r.role === 'owner' ? 'primary' : 'outline'}>{r.role}</Badge> },
    { key: 'mfa', header: 'MFA', cell: (r) => <YesNo value={r.mfa_enabled} yes="Enrolled" no="None" /> },
    { key: 'locked', header: 'Locked', cell: (r) => (r.locked_at ? <Badge variant="danger">Locked</Badge> : <span className="text-muted-foreground">–</span>) },
    { key: 'joined', header: 'Joined', cell: (r) => formatDate(r.joined_at) },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      cell: (r) => {
        const denied = can.supportActions() ?? (r.role === 'owner' ? OWNER_DENIED : null);
        return (
          <span className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
            <PermissionButton
              variant="outline"
              size="sm"
              denied={denied}
              onClick={() => {
                setRole('');
                setChanging(r);
              }}
            >
              Change role
            </PermissionButton>
            <PermissionButton variant="danger-outline" size="sm" denied={denied} onClick={() => setRemoving(r)}>
              Remove
            </PermissionButton>
          </span>
        );
      },
    },
  ];

  return (
    <>
      <QueryList query={members} rows={members.data} empty={{ title: 'No members' }}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Members" onRowClick={(r) => router.push(userPath(r.user_id))} />}
      </QueryList>
      <StaffActionDialog
        open={Boolean(changing)}
        onOpenChange={(open) => (open ? undefined : setChanging(null))}
        title={`Change the role of ${changing?.email ?? ''}`}
        description={`Now ${changing?.role ?? ''}. The new role applies to their next request.`}
        confirmLabel="Change role"
        extraValid={Boolean(role) && role !== changing?.role}
        onConfirm={changeRole}
      >
        <Field id="member-role" label="New role" required>
          <Select value={role} onValueChange={(v) => setRole(v as AssignableRole)}>
            <SelectTrigger id="member-role" aria-label="New role">
              <SelectValue placeholder="Choose a role" />
            </SelectTrigger>
            <SelectContent>
              {assignableRole.options.map((r) => (
                <SelectItem key={r} value={r} disabled={r === changing?.role}>
                  {ROLE_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </StaffActionDialog>
      <StaffActionDialog
        open={Boolean(removing)}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={`Remove ${removing?.email ?? ''}`}
        consequences={['They lose access to this workspace on their next request.', 'Their account and their other workspaces are untouched.', 'The workspace can invite them again later.']}
        confirmLabel="Remove member"
        destructive
        typeToConfirm={removing?.email}
        typeLabel="Type their email to confirm"
        onConfirm={removeMember}
      />
    </>
  );
}
