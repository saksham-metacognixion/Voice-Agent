'use client';

import { ApiError, useAdminInviteStaff, useAdminListStaff, useAdminUpdateStaff, useApi } from '@portal/api-client';
import { staffRole, type StaffMemberResponse, type StaffRole } from '@portal/schemas';
import {
  Alert, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Textarea, toast,
} from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import * as React from 'react';
import { ConfirmDialog } from '@/src/components/common/confirm-dialog';
import { CellActions, DataTable, type DataColumn } from '@/src/components/common/data-table';
import { PermissionButton } from '@/src/components/common/permission-button';
import { QueryList } from '@/src/components/common/query-states';
import { YesNo } from '@/src/components/common/status-badges';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime, relativeTime } from '@/src/lib/format';
import { ROLE_LABELS } from '@/src/lib/permissions';
import { useStaff } from '@/src/staff/staff-provider';

const ROLES: StaffRole[] = staffRole.options;

/** Admin §2.2 — one tone per role, so the table and the limits grid agree. */
export function StaffRoleBadge({ role }: { role: StaffRole }) {
  const variant = role === 'super_admin' ? 'premium' : role === 'ops' ? 'info' : role === 'finance' ? 'primary' : role === 'support' ? 'success' : 'outline';
  return <Badge variant={variant}>{ROLE_LABELS[role]}</Badge>;
}

const ROLE_HINTS: Record<StaffRole, string> = {
  super_admin: 'Everything, including pricing publish, staff and the limits matrix.',
  ops: 'Runs the platform: customers, numbers, jobs, flags and kill switches.',
  finance: 'Pricing drafts, refunds up to the limit, no customer pauses.',
  support: 'Customer help: small credit adjustments, pauses with a ticket.',
  read_only: 'Sees everything, changes nothing.',
};

/** SA13 Members: every staff row, an Invite dialog, and per-row role and activation changes. */
export function MembersTab() {
  const api = useApi();
  const { me, can } = useStaff();
  const denied = can.manageStaff();
  const list = useAdminListStaff(api, { refetchInterval: 30_000, staleTime: 10_000 });
  const [inviting, setInviting] = React.useState(false);
  const [roleTarget, setRoleTarget] = React.useState<StaffMemberResponse | null>(null);
  const [activeTarget, setActiveTarget] = React.useState<StaffMemberResponse | null>(null);

  const columns: Array<DataColumn<StaffMemberResponse>> = [
    {
      key: 'email',
      header: 'Email',
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{r.email}</span>
          {r.id === me.id ? <Badge variant="outline">you</Badge> : null}
          {!r.bound ? <Badge variant="warning">invited, not signed in yet</Badge> : null}
        </span>
      ),
    },
    { key: 'name', header: 'Name', cell: (r) => r.name ?? <span className="text-muted-foreground">–</span> },
    { key: 'role', header: 'Role', cell: (r) => <StaffRoleBadge role={r.role} /> },
    { key: 'mfa', header: 'MFA', cell: (r) => <YesNo value={r.mfa_enforced} yes="Required" no="Not enforced" /> },
    { key: 'active', header: 'Active', cell: (r) => <YesNo value={r.active} yes="Active" no="Deactivated" /> },
    {
      key: 'last',
      header: 'Last sign-in',
      cell: (r) => (r.last_login_at ? <span className="whitespace-nowrap text-muted-foreground" title={formatDateTime(r.last_login_at, { seconds: true })}>{relativeTime(r.last_login_at)}</span> : <span className="text-muted-foreground">never</span>),
    },
    { key: 'created', header: 'Added', cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.created_at)}</span> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => {
        const self = r.id === me.id;
        const selfDenied = self ? 'You cannot change your own role or deactivate yourself.' : null;
        return (
          <CellActions>
            <PermissionButton size="sm" variant="outline" denied={denied ?? selfDenied} onClick={() => setRoleTarget(r)}>
              Change role
            </PermissionButton>
            <PermissionButton size="sm" variant={r.active ? 'danger-outline' : 'outline'} denied={denied ?? selfDenied} onClick={() => setActiveTarget(r)}>
              {r.active ? 'Deactivate' : 'Reactivate'}
            </PermissionButton>
          </CellActions>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Sign-in is through the staff identity tenant; an invite is bound to the person the first time they sign in with that email.</p>
        <PermissionButton size="sm" denied={denied} onClick={() => setInviting(true)}>
          <UserPlus /> Invite
        </PermissionButton>
      </div>
      <QueryList query={list} rows={list.data} empty={{ title: 'No staff members' }}>
        {(rows) => <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} label="Staff members" rowClassName={(r) => (r.id === me.id ? 'bg-primary/5' : r.active ? undefined : 'opacity-60')} />}
      </QueryList>
      {inviting ? <InviteDialog onClose={() => setInviting(false)} /> : null}
      <ChangeRoleDialog member={roleTarget} onClose={() => setRoleTarget(null)} />
      <ToggleActiveDialog member={activeTarget} onClose={() => setActiveTarget(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------- invite

function InviteDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const invite = useAdminInviteStaff(api);
  const [email, setEmail] = React.useState('');
  const [name, setName] = React.useState('');
  const [role, setRole] = React.useState<StaffRole>('support');
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function submit() {
    if (!emailOk || busy) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const created = await invite.mutateAsync({ body: { email: email.trim(), name: name.trim() || undefined, role } });
      await queryClient.invalidateQueries({ queryKey: ['adminListStaff'] });
      toast.success(`${created.email} invited as ${ROLE_LABELS[created.role]}`, { description: 'They sign in with that email; the console recognises them on their first request.' });
      onClose();
    } catch (e) {
      // The API's `fields` (a foreign domain, a bad address) land on the input they name.
      if (e instanceof ApiError && e.code === 'VALIDATION_FAILED' && e.body.fields?.length) {
        const errs: Record<string, string> = {};
        for (const f of e.body.fields) errs[f.field] = f.message;
        setFieldErrors(errs);
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o || busy ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a staff member</DialogTitle>
          <DialogDescription>Company-domain addresses only. The person signs in with their Workspace account and a second factor.</DialogDescription>
        </DialogHeader>
        <Field id="invite-email" label="Email" required error={fieldErrors.email}>
          <Input id="invite-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" onKeyDown={(e) => (e.key === 'Enter' ? void submit() : undefined)} />
        </Field>
        <Field id="invite-name" label="Name" optional error={fieldErrors.name}>
          <Input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <Field id="invite-role" label="Role" required error={fieldErrors.role} description={ROLE_HINTS[role]}>
          <Select value={role} onValueChange={(v) => setRole(v as StaffRole)}>
            <SelectTrigger id="invite-role" aria-label="Role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!emailOk || busy} loading={busy}>
            Send invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------- change role

function useStaffUpdate() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { refetch } = useStaff();
  const update = useAdminUpdateStaff(api);
  return async (id: string, body: Parameters<typeof update.mutateAsync>[0]['body']) => {
    const res = await update.mutateAsync({ params: { id }, body });
    await queryClient.invalidateQueries({ queryKey: ['adminListStaff'] });
    // A role change is what `GET /admin/me` reads the limits from.
    await refetch();
    return res;
  };
}

function ChangeRoleDialog({ member, onClose }: { member: StaffMemberResponse | null; onClose: () => void }) {
  const update = useStaffUpdate();
  const [role, setRole] = React.useState<StaffRole>('support');
  const [note, setNote] = React.useState('');
  React.useEffect(() => {
    if (member) {
      setRole(member.role);
      setNote('');
    }
  }, [member]);
  const changed = member ? role !== member.role : false;
  return (
    <ConfirmDialog
      open={Boolean(member)}
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={`Change role · ${member?.email ?? ''}`}
      description={member ? `Currently ${ROLE_LABELS[member.role]}. The new limits apply on their next request.` : undefined}
      confirmLabel="Change role"
      destructive={role === 'super_admin'}
      confirmDisabled={!changed}
      onConfirm={async () => {
        if (!member || !changed) return;
        await update(member.id, { role, note: note.trim() || undefined });
        toast.success(`${member.email} is now ${ROLE_LABELS[role]}`);
      }}
    >
      <Field id="role-select" label="New role" description={ROLE_HINTS[role]}>
        <Select value={role} onValueChange={(v) => setRole(v as StaffRole)}>
          <SelectTrigger id="role-select" aria-label="New role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field id="role-note" label="Note" optional description="Goes in the staff audit log.">
        <Textarea id="role-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
      </Field>
      {!changed ? <p className="text-xs text-muted-foreground">Pick a different role to continue.</p> : null}
    </ConfirmDialog>
  );
}

// ---------------------------------------------------------------------------- deactivate / reactivate

function ToggleActiveDialog({ member, onClose }: { member: StaffMemberResponse | null; onClose: () => void }) {
  const update = useStaffUpdate();
  const [note, setNote] = React.useState('');
  React.useEffect(() => {
    if (member) setNote('');
  }, [member]);
  const deactivating = member?.active ?? false;
  return (
    <ConfirmDialog
      open={Boolean(member)}
      onOpenChange={(o) => (o ? undefined : onClose())}
      title={`${deactivating ? 'Deactivate' : 'Reactivate'} ${member?.email ?? ''}`}
      consequences={
        deactivating
          ? ['Their very next request to the console is refused; there is no token to wait out.', 'Their audit history stays. Reactivate later from this table.', member?.role === 'super_admin' ? 'A super admin: the API refuses this if they are the last active one.' : 'Open view-as sessions they started are refused too.']
          : ['They can sign in again with the same email and role.', 'Their limits are the role’s current limits.']
      }
      confirmLabel={deactivating ? 'Deactivate' : 'Reactivate'}
      destructive={deactivating}
      typeToConfirm={deactivating ? member?.email : undefined}
      typeLabel={deactivating ? 'Type their email to confirm' : undefined}
      onConfirm={async () => {
        if (!member) return;
        await update(member.id, { active: !deactivating, note: note.trim() || undefined });
        toast.success(`${member.email} ${deactivating ? 'deactivated' : 'reactivated'}`);
      }}
    >
      <Field id="active-note" label="Note" optional description="Goes in the staff audit log.">
        <Textarea id="active-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
      </Field>
    </ConfirmDialog>
  );
}
