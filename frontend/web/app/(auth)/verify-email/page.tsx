'use client';

import { isApiError, resendVerificationEmail, useApi } from '@portal/api-client';
import { VERIFICATION_RESEND_COOLDOWN_S } from '@portal/schemas';
import { Alert, Button } from '@portal/ui';
import { MailCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useAuth } from '@/src/auth/auth-provider';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { RequireAuth } from '@/src/guards/guards';
import { readQuery } from '@/src/lib/query-string';
import { routes, safeNext } from '@/src/routes';

/**
 * A3 — Verify email. The claim on the token gates the API (`403 EMAIL_UNVERIFIED`), so
 * "I have confirmed it" re-mints the session to pick up the new claim, then moves on.
 *
 * §6.3 A2 "Resend" (ADR 0036 §8): the API sends a fresh link (an expired one is answered
 * the same way) and counts the 60-second cooldown and the 5-an-hour cap itself; the
 * countdown here is a mirror of what it answered, kept in session storage so a reload
 * does not hide it. Nothing on this page lets anyone past the gate — every guarded route
 * and the API read the verified claim, not this page.
 */
export default function VerifyEmailPage() {
  return (
    <RequireAuth>
      <VerifyInner />
    </RequireAuth>
  );
}

function VerifyInner() {
  const t = useTranslations();
  const auth = useAuth();
  const router = useRouter();
  const [checking, setChecking] = React.useState(false);
  const [still, setStill] = React.useState(false);
  const api = useApi();
  const cooldownKey = `portal:verify-resend:${auth.user?.id ?? ''}`;
  const [until, setUntil] = React.useState<number>(() => readUntil(cooldownKey));
  const [now, setNow] = React.useState(() => Date.now());
  const [sending, setSending] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const left = Math.max(0, Math.ceil((until - now) / 1000));

  React.useEffect(() => {
    if (left <= 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [left]);

  function coolFor(seconds: number) {
    const at = Date.now() + seconds * 1000;
    setUntil(at);
    setNow(Date.now());
    try {
      sessionStorage.setItem(cooldownKey, String(at));
    } catch {
      /* private mode: the countdown just does not survive a reload */
    }
  }

  async function resend() {
    setSending(true);
    setNotice(null);
    try {
      const res = await resendVerificationEmail(api);
      if (res.status === 'already_verified') {
        setNotice({ tone: 'success', text: t('auth.verify.alreadyVerified') });
        const fresh = await auth.refresh();
        if (fresh?.emailVerified) router.replace(next);
      } else {
        coolFor(res.retry_after_s || VERIFICATION_RESEND_COOLDOWN_S);
        setNotice({ tone: 'success', text: t('auth.verify.resent', { email: auth.user?.email ?? '' }) });
      }
    } catch (e) {
      if (isApiError(e, 'RATE_LIMITED')) {
        const seconds = Number(e.fieldMessage('retry_after_s')) || VERIFICATION_RESEND_COOLDOWN_S;
        coolFor(seconds);
        setNotice({ tone: 'warning', text: t('auth.verify.resendLimited', { seconds }) });
      } else {
        // A2's own sentence for every other refusal (no provider here, provider down): what
        // happened, never a generic "not ready" and never a fake "sent".
        setNotice({ tone: 'danger', text: t('auth.verify.resendFailed') });
      }
    } finally {
      setSending(false);
    }
  }
  // Where the person was going before A3 stopped them — an invite, a deep link — validated
  // as same-origin; `/` and its gate otherwise (BUG-008, QA-002). Read once on the client.
  const next = React.useMemo(() => safeNext(readQuery().get('next'), routes.root), []);

  React.useEffect(() => {
    if (auth.user?.emailVerified) router.replace(next);
  }, [auth.user?.emailVerified, router, next]);

  async function check() {
    setChecking(true);
    setStill(false);
    const fresh = await auth.refresh();
    setChecking(false);
    if (fresh?.emailVerified) router.replace(next);
    else setStill(true);
  }

  return (
    <AuthLayout title={t('auth.verify.title')}>
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3 rounded-lg bg-accent/60 p-4 text-sm">
          <MailCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <p>{auth.user?.email ? t('auth.verify.body', { email: auth.user.email }) : t('auth.verify.bodyNoEmail')}</p>
        </div>
        {still ? <Alert variant="warning">{t('auth.verify.stillUnverified')}</Alert> : null}
        {notice ? (
          <Alert variant={notice.tone}>
            {notice.text}
          </Alert>
        ) : null}
        <Button size="lg" onClick={check} loading={checking} className="w-full">
          {checking ? t('auth.verify.checking') : t('auth.verify.check')}
        </Button>
        <div className="flex flex-col items-center gap-1">
          <Button variant="outline" className="w-full" onClick={() => void resend()} disabled={left > 0 || sending} loading={sending}>
            {left > 0 ? t('auth.verify.resendIn', { seconds: left }) : t('auth.verify.resend')}
          </Button>
          <p className="text-center text-xs text-muted-foreground">{t('auth.verify.expired')}</p>
        </div>
        <p className="text-center text-xs text-muted-foreground">{t('auth.verify.spam')}</p>
        <Button variant="ghost" onClick={() => void auth.logout()}>
          {t('auth.verify.useAnother')}
        </Button>
      </div>
    </AuthLayout>
  );
}

function readUntil(key: string): number {
  try {
    const raw = Number(sessionStorage.getItem(key));
    return Number.isFinite(raw) ? raw : 0;
  } catch {
    return 0;
  }
}
