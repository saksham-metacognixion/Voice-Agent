'use client';

import { inviteHintResponse } from '@portal/schemas';
import { Lock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { config } from '../config';
import { inviteTokenFrom } from './pending-invite';

/**
 * A8 "sign up/login with email pre-filled and locked to invitee address" (ADR 0036 §7).
 * The address comes from `GET /invites/:token/hint` — public, because the person has no
 * session yet, so a plain `fetch` rather than the API client (which asks Auth0 for a token
 * first). It is handed to Universal Login as `login_hint`. Universal Login lets the field
 * be edited; the lock that holds is the API's: an invite accepted from any other address
 * is `INVITE_WRONG_EMAIL`, and this page says so before the person leaves.
 */
export function useInvitedEmail(next: string): string | null {
  const [email, setEmail] = React.useState<string | null>(null);
  React.useEffect(() => {
    const token = inviteTokenFrom(next || null);
    if (!token) return;
    const controller = new AbortController();
    fetch(`${config.apiUrl}/invites/${encodeURIComponent(token)}/hint`, { signal: controller.signal })
      .then(async (res) => (res.ok ? inviteHintResponse.safeParse(await res.json()) : null))
      .then((parsed) => setEmail(parsed?.success ? parsed.data.email : null))
      .catch(() => setEmail(null));
    return () => controller.abort();
  }, [next]);
  return email;
}

/** The invited address, shown read-only above the sign-in button. */
export function InvitedAs({ email }: { email: string }) {
  const t = useTranslations('auth.invited');
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <span className="flex items-center gap-2 font-medium">
        <Lock className="size-4 text-muted-foreground" aria-hidden />
        <span dir="ltr">{t('as', { email })}</span>
      </span>
      <span className="text-xs text-muted-foreground">{t('hint', { email })}</span>
    </div>
  );
}
