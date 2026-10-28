'use client';

import {
  useAdminForceLogoutUser, useAdminGetUser, useAdminLockUser, useAdminResetUserMfa, useAdminUnlockUser, useAdminVerifyUserEmail, useApi,
} from '@portal/api-client';
import type { AdminUserActionResponse, StaffActionRequest } from '@portal/schemas';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import * as React from 'react';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { Copyable } from '@/src/components/common/copyable';
import { PermissionButton } from '@/src/components/common/permission-button';
import { Fact, FactGrid, LoadError } from '@/src/components/common/query-states';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { YesNo } from '@/src/components/common/status-badges';
import { formatDateTime } from '@/src/lib/format';
import { useUrlQuery } from '@/src/lib/use-url-query';
import { customerPath, routes } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

type Action = 'verify' | 'reset_mfa' | 'lock' | 'unlock' | 'logout';

export default function UserDetailPage() {
  return (
    <AdminShell>
      <UserDetail />
    </AdminShell>
  );
}

function UserDetail() {
  const [params] = useUrlQuery();
  const id = params.get('id') ?? '';
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const user = useAdminGetUser(api, { id }, { enabled: Boolean(id) });
  const verify = useAdminVerifyUserEmail(api);
  const resetMfa = useAdminResetUserMfa(api);
  const lock = useAdminLockUser(api);
  const unlock = useAdminUnlockUser(api);
  const logout = useAdminForceLogoutUser(api);
  const [action, setAction] = React.useState<Action | null>(null);
  const denied = can.supportActions();

  if (!id) return <EmptyState title="No user selected" action={<Link href={routes.users} className="text-sm text-primary underline">Back to users</Link>} />;

  async function run(a: Action, body: StaffActionRequest) {
    const vars = { params: { id }, body };
    let res: AdminUserActionResponse;
    switch (a) {
      case 'verify':
        res = await verify.mutateAsync(vars);
        break;
      case 'reset_mfa':
        res = await resetMfa.mutateAsync(vars);
        break;
      case 'lock':
        res = await lock.mutateAsync(vars);
        break;
      case 'unlock':
        res = await unlock.mutateAsync(vars);
        break;
      case 'logout':
        res = await logout.mutateAsync(vars);
        break;
    }
    await queryClient.invalidateQueries({ queryKey: ['adminGetUser'] });
    await queryClient.invalidateQueries({ queryKey: ['adminListUsers'] });
    await queryClient.invalidateQueries({ queryKey: ['adminCustomerMembers'] });
    if (res.provider === 'skipped') toast.warning('Applied locally only — identity provider not configured');
    else if (res.provider === 'failed') toast.error('Sessions ended in the API, but the identity provider refused', { description: res.provider_error ?? 'Retry to revoke its sessions too.' });
    // A lock whose session revoke the provider refused (QA-042): locked, but say so.
    else if (res.provider_error) toast.warning(ACTIONS[a].done, { description: res.provider_error });
    else toast.success(ACTIONS[a].done);
  }

  const u = user.data;
  const title = u?.email ?? 'User';
  return (
    <>
      <PageHeader
        title={title}
        crumbs={[{ label: 'Users', href: routes.users }, { label: title }]}
        description={u ? <Copyable value={u.id} full /> : undefined}
        actions={
          u ? (
            <>
              <PermissionButton variant="outline" size="sm" denied={denied} onClick={() => setAction('verify')} disabled={u.email_verified === true}>
                Verify email
              </PermissionButton>
              <PermissionButton variant="outline" size="sm" denied={denied} onClick={() => setAction('reset_mfa')} disabled={!u.mfa_enabled}>
                Reset MFA
              </PermissionButton>
              <PermissionButton variant="outline" size="sm" denied={denied} onClick={() => setAction('logout')}>
                Force logout
              </PermissionButton>
              {u.locked_at ? (
                <PermissionButton variant="outline" size="sm" denied={denied} onClick={() => setAction('unlock')}>
                  Unlock
                </PermissionButton>
              ) : (
                <PermissionButton variant="danger-outline" size="sm" denied={denied} onClick={() => setAction('lock')}>
                  Lock sign-in
                </PermissionButton>
              )}
            </>
          ) : null
        }
      />
      {user.isPending ? (
        <Skeleton className="h-48" aria-busy />
      ) : user.isError ? (
        <LoadError error={user.error} onRetry={() => void user.refetch()} back={{ href: routes.users, label: 'Back to users' }} />
      ) : !u ? null : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Profile</CardTitle>
            </CardHeader>
            <CardContent>
              <FactGrid columns={2}>
                <Fact label="Email" wrap>
                  {u.email}
                </Fact>
                <Fact label="Name">{u.name ?? '–'}</Fact>
                <Fact label="Email verified (provider)">{u.email_verified === null ? <span className="text-muted-foreground">unknown (provider not configured)</span> : <YesNo value={u.email_verified} yes="Verified" no="Unverified" />}</Fact>
                <Fact label="Second factor">
                  <YesNo value={u.mfa_enabled} yes="Enrolled" no="None" />
                </Fact>
                <Fact label="Locked">{u.locked_at ? <Badge variant="danger">Since {formatDateTime(u.locked_at)}</Badge> : <span className="text-muted-foreground">No</span>}</Fact>
                <Fact label="Lock reason" wrap>
                  {u.locked_reason ?? '–'}
                </Fact>
                <Fact label="Sessions ended">{u.sessions_revoked_at ? formatDateTime(u.sessions_revoked_at) : <span className="text-muted-foreground">Never</span>}</Fact>
                <Fact label="Created">{formatDateTime(u.created_at)}</Fact>
              </FactGrid>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Workspaces</CardTitle>
            </CardHeader>
            <CardContent>
              {u.memberships.length ? (
                <ul className="divide-y divide-border">
                  {u.memberships.map((m) => (
                    <li key={m.tenant_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <Link href={customerPath(m.tenant_id, 'members')} className="truncate font-medium hover:text-primary">
                        {m.tenant_name}
                      </Link>
                      <Badge variant="outline">{m.role}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No memberships.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      {action ? (
        <StaffActionDialog
          open
          onOpenChange={(o) => (o ? undefined : setAction(null))}
          title={ACTIONS[action].title}
          description={u?.email}
          consequences={ACTIONS[action].consequences}
          confirmLabel={ACTIONS[action].confirm}
          destructive={ACTIONS[action].destructive}
          typeToConfirm={ACTIONS[action].destructive ? (u?.email ?? undefined) : undefined}
          typeLabel="Type the email address to confirm"
          onConfirm={(body) => run(action, body)}
        />
      ) : null}
    </>
  );
}

const ACTIONS: Record<Action, { title: string; confirm: string; done: string; destructive: boolean; consequences: string[] }> = {
  verify: { title: 'Mark email verified', confirm: 'Verify email', done: 'Email marked verified', destructive: false, consequences: ['The identity provider marks the address verified.', 'A3 gating in the portal lifts on the next token refresh.'] },
  reset_mfa: { title: 'Reset second factor', confirm: 'Reset MFA', done: 'Second factor removed', destructive: true, consequences: ['Every enrolled authenticator and recovery code is removed.', 'The person enrols again on their next sign-in.', 'Do this only after verifying identity out of band.'] },
  lock: { title: 'Lock sign-in', confirm: 'Lock', done: 'Sign-in locked', destructive: true, consequences: ['Blocked at the identity provider and refused by the API.', 'Active sessions end on their next request.', 'Their workspaces keep running.'] },
  unlock: { title: 'Unlock sign-in', confirm: 'Unlock', done: 'Sign-in unlocked', destructive: false, consequences: ['The person can sign in again immediately.'] },
  logout: { title: 'Force logout', confirm: 'Force logout', done: 'Sessions revoked', destructive: false, consequences: ['Every session and refresh token is revoked.', 'Open portal tabs are sent to sign in on their next request.'] },
};
