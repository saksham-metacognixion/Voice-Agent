'use client';

import { isApiError, useApi } from '@portal/api-client';
import { acceptInviteResponse, type AcceptInviteResponse } from '@portal/schemas';
import { Alert, Button } from '@portal/ui';
import { UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { useAuth } from '@/src/auth/auth-provider';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { RequireVerified } from '@/src/guards/guards';
import { errorMessage } from '@/src/lib/errors';
import { readQuery } from '@/src/lib/query-string';
import { routes } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * A8 — Accept invite. `/invite/?token=…` (the spec's `/invite/[token]`, flattened for the
 * static export). Requires a verified sign-in as the invited address; the token is the
 * authorisation, and `POST /invites/:token/accept` sends no workspace header.
 */
export default function InvitePage() {
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
  }, []);

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
      if (isApiError(e, 'ALREADY_MEMBER')) setError(t('auth.invite.alreadyMember'));
      else if (isApiError(e, 'INVITE_INVALID') || isApiError(e, 'NOT_FOUND')) setError(t('auth.invite.invalid'));
      else setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title={t('auth.invite.title')} subtitle={result ? undefined : t('auth.invite.body')}>
      <div className="flex flex-col gap-4">
        {token === null ? <Alert variant="warning">{t('auth.invite.missing')}</Alert> : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
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
            {auth.user?.email ? <p className="text-xs text-muted-foreground">{t('auth.invite.wrongAccount', { email: auth.user.email })}</p> : null}
            <Button size="lg" className="w-full" onClick={go} loading={busy} disabled={!token}>
              {t('auth.invite.accept')}
            </Button>
            <Button variant="ghost" onClick={() => void auth.logout(routes.login)}>
              {t('common.signOut')}
            </Button>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
