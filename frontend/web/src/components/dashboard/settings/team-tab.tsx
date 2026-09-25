'use client';

import { createInvite, removeMember, revokeInvite, transferOwnership, updateMember, useApi, useListInvites, useListMembers } from '@portal/api-client';
import { inviteRequest, type AssignableRole, type InviteResponse, type MemberResponse } from '@portal/schemas';
import {
  Alert, Avatar, AvatarFallback, AvatarImage, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input, Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue, Skeleton, initials, toast,
} from '@portal/ui';
import { Copy, Crown, MailPlus, UserMinus, Users } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { useAuth } from '@/src/auth/auth-provider';
import { ConfirmDialog } from '@/src/components/dashboard/confirm-dialog';
import { DataTable, type DataColumn } from '@/src/components/dashboard/data-table';
import { LoadError } from '@/src/components/dashboard/query-states';
import { errorMessage } from '@/src/lib/errors';
import { formatDate } from '@/src/lib/format';
import { routes } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';

const ASSIGNABLE: AssignableRole[] = ['admin', 'editor', 'viewer'];

/**
 * D6 Team (spec p. 39): members with their role, invite (email + role → a link shown
 * once), change role, remove, and transfer ownership (owner only, the email typed to
 * confirm). Every member can read the list; only an owner or admin sees the controls,
 * and the API refuses the rest anyway — including touching the owner's own row.
 */
export function TeamTab() {
  const t = useTranslations('dashboard.settings.team');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { canAdmin, isOwner } = useRole();
  const members = useListMembers(api, { staleTime: 30_000 });
  const [removing, setRemoving] = React.useState<MemberResponse | null>(null);
  const [transferring, setTransferring] = React.useState<MemberResponse | null>(null);
  const [changing, setChanging] = React.useState<string | null>(null);
  const tz = ws.workspace?.timezone;
  const me = auth.user?.email?.toLowerCase();
  const nameOf = (m: MemberResponse) => m.name ?? m.email;

  async function changeRole(m: MemberResponse, role: AssignableRole) {
    if (role === m.role) return;
    setChanging(m.id);
    try {
      await updateMember(api, { id: m.id }, { role });
      await queryClient.invalidateQueries({ queryKey: ['listMembers'] });
      track('member_role_changed', { role });
      toast.success(t('roleChanged', { name: nameOf(m), role: t(`roles.${role}`) }));
    } catch (e) {
      toast.error(errorMessage(e, tc));
    } finally {
      setChanging(null);
    }
  }

  const columns: Array<DataColumn<MemberResponse>> = [
    {
      key: 'name',
      header: t('columns.name'),
      card: 'title',
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar className="size-8 shrink-0">
            {m.avatar_url ? <AvatarImage src={m.avatar_url} alt="" /> : null}
            <AvatarFallback>{initials(m.name ?? m.email)}</AvatarFallback>
          </Avatar>
          <span className="min-w-0 break-words font-medium">
            {nameOf(m)}
            {m.email.toLowerCase() === me ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">({t('you')})</span> : null}
          </span>
        </span>
      ),
    },
    { key: 'email', header: t('columns.email'), card: 'subtitle', cell: (m) => <span className="break-all">{m.email}</span> },
    {
      key: 'role',
      header: t('columns.role'),
      cell: (m) =>
        canAdmin && m.role !== 'owner' && m.email.toLowerCase() !== me ? (
          <Select value={m.role} onValueChange={(v) => void changeRole(m, v as AssignableRole)} disabled={changing === m.id}>
            <SelectTrigger className="h-8 w-32" aria-label={t('roleLabel', { name: nameOf(m) })} onClick={(e) => e.stopPropagation()}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ASSIGNABLE.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(`roles.${r}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Badge variant={m.role === 'owner' ? 'primary' : 'outline'}>{t(`roles.${m.role}`)}</Badge>
        ),
    },
    { key: 'joined', header: t('columns.joined'), className: 'hidden md:table-cell', cell: (m) => formatDate(m.joined_at, tz) },
    {
      key: 'actions',
      header: <span className="sr-only">{t('columns.actions')}</span>,
      card: 'actions',
      align: 'right',
      cell: (m) => {
        const self = m.email.toLowerCase() === me;
        if (m.role === 'owner' || self || !canAdmin) return null;
        return (
          <div className="flex w-full flex-wrap justify-end gap-2">
            {isOwner ? (
              <Button variant="ghost" size="sm" onClick={() => setTransferring(m)}>
                <Crown /> {t('transfer')}
              </Button>
            ) : null}
            <Button variant="danger-outline" size="sm" onClick={() => setRemoving(m)}>
              <UserMinus /> {t('remove')}
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-4 text-primary" aria-hidden /> {t('title')}
          </CardTitle>
          <CardDescription>{t('body')}</CardDescription>
        </CardHeader>
        <CardContent>
          {members.isPending ? (
            <Skeleton className="h-32 w-full" aria-busy />
          ) : members.isError ? (
            <LoadError compact error={members.error} onRetry={() => void members.refetch()} />
          ) : (
            <DataTable label={t('label')} rows={members.data} columns={columns} rowKey={(m) => m.id} />
          )}
        </CardContent>
      </Card>

      {canAdmin ? <InviteCard /> : null}
      {canAdmin ? <PendingInvites /> : null}

      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
        title={removing ? t('removeTitle', { name: nameOf(removing) }) : ''}
        description={t('removeBody')}
        confirmLabel={t('remove')}
        onConfirm={async () => {
          if (!removing) return;
          await removeMember(api, { id: removing.id });
          await queryClient.invalidateQueries({ queryKey: ['listMembers'] });
          track('member_removed');
          toast.success(t('removed', { name: nameOf(removing) }));
        }}
      />
      <ConfirmDialog
        open={Boolean(transferring)}
        onOpenChange={(open) => (open ? undefined : setTransferring(null))}
        title={transferring ? t('transferTitle', { name: nameOf(transferring) }) : ''}
        description={transferring ? t('transferBody', { name: nameOf(transferring) }) : undefined}
        confirmLabel={t('transfer')}
        typeToConfirm={transferring?.email}
        typeLabel={transferring ? t('transferType', { email: transferring.email }) : undefined}
        onConfirm={async () => {
          if (!transferring) return;
          await transferOwnership(api, { user_id: transferring.user_id });
          track('ownership_transferred');
          // The caller's own role changed: every role-gated view must re-read it.
          await Promise.all([queryClient.invalidateQueries({ queryKey: ['listMembers'] }), queryClient.invalidateQueries({ queryKey: ['getWorkspace'] }), queryClient.invalidateQueries({ queryKey: ['listMyWorkspaces'] })]);
          toast.success(t('transferred', { name: nameOf(transferring) }));
        }}
      />
    </div>
  );
}

/** Invite by email and role; the API returns the token once, so the link is shown once to copy (no email is sent yet). */
function InviteCard() {
  const t = useTranslations('dashboard.settings.team');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<AssignableRole>('editor');
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [created, setCreated] = React.useState<InviteResponse | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const parsed = inviteRequest.safeParse({ email, role });
    if (!parsed.success) {
      setFieldError(t('emailError'));
      return;
    }
    setFieldError(null);
    setError(null);
    setBusy(true);
    try {
      const invite = await createInvite(api, parsed.data);
      setCreated(invite);
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: ['listInvites'] });
      track('member_invited', { role: parsed.data.role });
      toast.success(t('invited', { email: invite.email }));
    } catch (err) {
      setError(errorMessage(err, tc));
    } finally {
      setBusy(false);
    }
  }

  const link = created?.token && typeof window !== 'undefined' ? `${window.location.origin}${routes.invite}?token=${encodeURIComponent(created.token)}` : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MailPlus className="size-4 text-primary" aria-hidden /> {t('inviteTitle')}
        </CardTitle>
        <CardDescription>{t('inviteBody')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form noValidate onSubmit={(e) => void submit(e)} className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
          <Field id="invite-email" label={t('email')} error={fieldError ?? undefined}>
            <Input id="invite-email" type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          </Field>
          <Field id="invite-role" label={t('role')}>
            <Select value={role} onValueChange={(v) => setRole(v as AssignableRole)} disabled={busy}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`roles.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button type="submit" loading={busy} disabled={busy || !email.trim()}>
            {t('invite')}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">{t(`roleHints.${role}`)}</p>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {created && link ? (
          <Alert variant="success" title={t('linkTitle', { email: created.email })}>
            <p className="mb-2">{t('linkBody', { email: created.email, date: formatDate(created.expires_at, ws.workspace?.timezone) })}</p>
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
              <Input value={link} readOnly aria-label={t('linkTitle', { email: created.email })} className="min-w-0 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(link).then(() => toast.success(tc('common.copied')));
                }}
              >
                <Copy /> {tc('common.copy')}
              </Button>
            </div>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function PendingInvites() {
  const t = useTranslations('dashboard.settings.team');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const invites = useListInvites(api, { staleTime: 30_000 });
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const pending = (invites.data ?? []).filter((i) => !i.accepted_at);

  const columns: Array<DataColumn<InviteResponse>> = [
    { key: 'email', header: t('inviteColumns.email'), card: 'title', cell: (i) => <span className="break-all">{i.email}</span> },
    { key: 'role', header: t('inviteColumns.role'), card: 'badge', cell: (i) => <Badge variant="outline">{t(`roles.${i.role}`)}</Badge> },
    { key: 'expires', header: t('inviteColumns.expires'), cell: (i) => formatDate(i.expires_at, ws.workspace?.timezone) },
    {
      key: 'actions',
      header: <span className="sr-only">{t('inviteColumns.actions')}</span>,
      card: 'actions',
      align: 'right',
      cell: (i) => (
        <Button
          variant="ghost"
          size="sm"
          loading={revoking === i.id}
          disabled={revoking !== null}
          onClick={async () => {
            setRevoking(i.id);
            try {
              await revokeInvite(api, { id: i.id });
              await queryClient.invalidateQueries({ queryKey: ['listInvites'] });
              toast.success(t('revoked'));
            } catch (e) {
              toast.error(errorMessage(e, tc));
            } finally {
              setRevoking(null);
            }
          }}
        >
          {t('revoke')}
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('invitesTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        {invites.isPending ? (
          <Skeleton className="h-16 w-full" aria-busy />
        ) : invites.isError ? (
          <LoadError compact error={invites.error} onRetry={() => void invites.refetch()} />
        ) : pending.length === 0 ? (
          <EmptyState className="py-6" icon={<MailPlus />} title={t('invitesEmpty')} />
        ) : (
          <DataTable label={t('invitesLabel')} rows={pending} columns={columns} rowKey={(i) => i.id} />
        )}
      </CardContent>
    </Card>
  );
}
