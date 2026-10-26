'use client';

import { isApiError, useApi } from '@portal/api-client';
import { acceptInviteResponse, invitePreviewResponse, type AcceptInviteResponse } from '@portal/schemas';
import { Alert, Button } from '@portal/ui';
import { useQuery } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { useAuth } from '@/src/auth/auth-provider';
import { pendingInvite } from '@/src/auth/pending-invite';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { RequireVerified } from '@/src/guards/guards';
import { errorMessage } from '@/src/lib/errors';
import { formatDate } from '@/src/lib/format';
import { currentPathWithQuery, readQuery } from '@/src/lib/query-string';
import { routes } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * A8 — Accept invite. `/invite/?token=…` (the spec's `/invite/[token]`, flattened for the
 * static export). Requires a verified sign-in as the invited address; the token is the
 * authorisation, and `POST /invites/:token/accept` sends no workspace header.
 *
 * Signed out or unverified, the guards send the person away with this page as `?next=`;
 * the link is also remembered (`pendingInvite`) for the steps a query string cannot
 * cross, so they come back here rather than to "set up a workspace" (BUG-008). Joining
 * is always the button — nothing accepts on arrival.
 */
export default function InvitePage() {
  const auth = useAuth();
  const waiting = auth.status === 'anonymous' || (auth.status === 'authenticated' && !auth.user?.emailVerified);

  React.useEffect(() => {
    if (waiting) pendingInvite.save(currentPathWithQuery());
  }, [waiting]);

  return (
    <RequireVerified>
      <InviteInner />
    </RequireVerified>
  );
}

function InviteInner() {
  const t = useTranslations();
  const api = useApi();
  const auth = useAuth();
  const ws = useWorkspace();
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [token, setToken] = React.useState<string | null | undefined>(undefined);
  const [result, setResult] = React.useState<AcceptInviteResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setToken(readQuery().get('token'));
    // Back on the join screen: the hint has done its job.
    pendingInvite.clear();
  }, []);

  // Who, where and which role, before the click. Answered to the invited address only,
  // so a wrong account learns nothing but "not for you". A refusal here is the answer —
  // no retries — and it is shown up front instead of after pressing Accept.
  const preview = useQuery({
    queryKey: ['previewInvite', token],
    queryFn: () => api.get(`/invites/${encodeURIComponent(token!)}/preview`, invitePreviewResponse, { noWorkspace: true }),
    enabled: Boolean(token),
    retry: false,
    staleTime: 60_000,
  });
  const refused = preview.isError ? inviteErrorCopy(preview.error, t, auth.user?.email ?? '') : null;
  const wrongEmail = preview.isError && isApiError(preview.error, 'INVITE_WRONG_EMAIL');

  async function go() {
    if (!token) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.post(`/invites/${encodeURIComponent(token)}/accept`, {}, acceptInviteResponse, { noWorkspace: true });
      setResult(res);
      track('invite_accepted', { role: res.role });
      await ws.refetchMemberships();
      ws.select(res.workspace_id);
    } catch (e) {
      setError(inviteErrorCopy(e, t, auth.user?.email ?? ''));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title={t('auth.invite.title')} subtitle={result ? undefined : t('auth.invite.body')}>
      <div className="flex flex-col gap-4">
        {token === null ? <Alert variant="warning">{t('auth.invite.missing')}</Alert> : null}
        {refused && !result ? <Alert variant="danger">{refused}</Alert> : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {preview.data && !result ? (
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 p-4 text-sm">
            <p>
              {t('auth.invite.details', {
                inviter: preview.data.invited_by,
                workspace: preview.data.workspace_name,
                role: t(`shell.role.${preview.data.role}` as never),
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {preview.data.already_member ? t('auth.invite.alreadyMemberHint') : t('auth.invite.expires', { date: formatDate(preview.data.expires_at) })}
            </p>
          </div>
        ) : null}
        {result ? (
          <>
            <Alert variant="success" icon={<UserPlus />}>
              {t('auth.invite.success', { workspace: result.workspace_name, role: t(`shell.role.${result.role}` as never) })}
            </Alert>
            <Button size="lg" className="w-full" onClick={() => router.replace(routes.root)}>
              {t('auth.invite.open')}
            </Button>
          </>
        ) : (
          <>
            {auth.user?.email && !wrongEmail ? <p className="text-xs text-muted-foreground">{t('auth.invite.wrongAccount', { email: auth.user.email })}</p> : null}
            {refused ? null : (
              <Button size="lg" className="w-full" onClick={go} loading={busy} disabled={!token || preview.isPending}>
                {preview.data?.already_member ? t('auth.invite.open') : t('auth.invite.accept')}
              </Button>
            )}
            <Button
              variant={wrongEmail ? 'outline' : 'ghost'}
              onClick={() => {
                // Signing out to switch to the invited address: come back here after.
                pendingInvite.save(currentPathWithQuery());
                void auth.logout();
              }}
            >
              {t('common.signOut')}
            </Button>
          </>
        )}
      </div>
    </AuthLayout>
  );
}

/** A8 refusals as copy, by code (never by text). The same for the preview and the accept. */
function inviteErrorCopy(e: unknown, t: ReturnType<typeof useTranslations>, email: string): string {
  if (isApiError(e, 'ALREADY_MEMBER')) return t('auth.invite.alreadyMember');
  if (isApiError(e, 'INVITE_EXPIRED')) return t('auth.invite.expired');
  if (isApiError(e, 'INVITE_USED')) return t('auth.invite.used');
  if (isApiError(e, 'INVITE_WRONG_EMAIL')) return t('auth.invite.wrongEmail', { email });
  if (isApiError(e, 'INVITE_INVALID') || isApiError(e, 'NOT_FOUND')) return t('auth.invite.invalid');
  return errorMessage(e, t);
}
