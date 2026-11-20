'use client';

import { acceptTerms, useApi, useGetAccount } from '@portal/api-client';
import { Alert, Button, Checkbox, PageLoader } from '@portal/ui';
import { FileCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { track } from '@/src/analytics/posthog';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { LegalDialog } from '@/src/components/legal/legal-dialog';
import { RequireAuth } from '@/src/guards/guards';
import { PRIVACY_POLICY, TERMS_OF_SERVICE, type LegalDocument } from '@/src/legal/documents';
import { errorMessage } from '@/src/lib/errors';
import { readQuery } from '@/src/lib/query-string';
import { routes, safeNext } from '@/src/routes';

/**
 * §6.3 A1 "[x] I agree to the Terms and Privacy Policy" (ADR 0036 §6). Universal Login
 * cannot carry a required checkbox, so this is the first screen after sign-in for anyone
 * who has not accepted the version in force — a new account, a Google sign-up, an invitee,
 * and everyone again when the version changes. Nothing is ticked for the person: the box
 * starts empty and Continue stays disabled until they tick it. The API records who, which
 * version, when and from where, and refuses a workspace, a join or a payment without it.
 */
export default function TermsPage() {
  return (
    <RequireAuth>
      <TermsInner />
    </RequireAuth>
  );
}

function TermsInner() {
  const t = useTranslations();
  const api = useApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useGetAccount(api);
  const [agreed, setAgreed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reading, setReading] = React.useState<LegalDocument | null>(null);
  // Read after the commit: the gate's `router.replace` here is a transition, and a render
  // inside it can still see the previous address.
  const [next, setNext] = React.useState<string | null>(null);
  React.useEffect(() => {
    setNext(safeNext(readQuery().get('next'), routes.root));
  }, []);

  React.useEffect(() => {
    if (next && me.data && !me.data.terms.required) router.replace(next);
  }, [me.data, next, router]);

  async function accept() {
    if (!me.data || !agreed) return;
    setBusy(true);
    setError(null);
    try {
      const terms = await acceptTerms(api, {
        version: me.data.terms.current_version,
        accepted: true,
      });
      queryClient.setQueryData(['getAccount'], { ...me.data, terms });
      track('terms_accepted', { version: terms.current_version });
      router.replace(next ?? routes.root);
    } catch (e) {
      setError(errorMessage(e, t));
      // A 409 means the version moved while the page was open: show the new one.
      void me.refetch();
      setBusy(false);
    }
  }

  if (me.isPending || (me.data && !me.data.terms.required))
    return <PageLoader label={t('common.loading')} />;
  const changed = Boolean(me.data?.terms.accepted_version);

  return (
    <AuthLayout
      title={t('auth.terms.title')}
      subtitle={changed ? t('auth.terms.updated') : t('auth.terms.body')}
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3 rounded-lg border border-border p-4 text-sm">
          <FileCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <div className="flex flex-col gap-1">
            <DocumentLink document={TERMS_OF_SERVICE} onOpen={setReading}>
              {t('auth.terms.termsLink')}
            </DocumentLink>
            <DocumentLink document={PRIVACY_POLICY} onOpen={setReading}>
              {t('auth.terms.privacyLink')}
            </DocumentLink>
            {me.data ? (
              <span className="text-xs text-muted-foreground">
                {t('auth.terms.version', { version: me.data.terms.current_version })}
              </span>
            ) : null}
          </div>
        </div>
        <label htmlFor="terms-agree" className="flex cursor-pointer items-start gap-3 text-sm">
          <Checkbox
            id="terms-agree"
            checked={agreed}
            onCheckedChange={(v) => setAgreed(v === true)}
            className="mt-0.5"
          />
          <span>{t('auth.terms.checkbox')}</span>
        </label>
        {me.isError ? <Alert variant="danger">{errorMessage(me.error, t)}</Alert> : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <Button
          size="lg"
          className="w-full"
          onClick={() => void accept()}
          disabled={!agreed || !me.data}
          loading={busy}
        >
          {busy ? t('auth.terms.accepting') : t('auth.terms.accept')}
        </Button>
      </div>
      <LegalDialog document={reading} onOpenChange={(open) => !open && setReading(null)} />
    </AuthLayout>
  );
}

/** Opens `LegalDialog`: the person reads the document without leaving the screen. */
function DocumentLink({
  document,
  onOpen,
  children,
}: {
  document: LegalDocument;
  onOpen: (document: LegalDocument) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="w-fit cursor-pointer rounded-sm text-start font-medium text-primary hover:underline"
      aria-haspopup="dialog"
      onClick={() => onOpen(document)}
    >
      {children}
    </button>
  );
}
