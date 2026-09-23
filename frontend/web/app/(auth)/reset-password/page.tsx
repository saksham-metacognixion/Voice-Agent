'use client';

import { Button } from '@portal/ui';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { AuthLayout } from '@/src/components/auth/auth-layout';
import { routes } from '@/src/routes';

/**
 * A6 — Reset password. The new password is set on Auth0's hosted page that the email
 * links to; this page is the landing spot afterwards (and for an old bookmark).
 */
export default function ResetPasswordPage() {
  const t = useTranslations();
  return (
    <AuthLayout title={t('auth.reset.title')} subtitle={t('auth.reset.body')}>
      <div className="flex flex-col gap-3">
        <Button size="lg" asChild className="w-full">
          <Link href={routes.login}>{t('auth.reset.cta')}</Link>
        </Button>
        <Button variant="ghost" asChild>
          <Link href={routes.forgotPassword}>{t('auth.reset.requestAnother')}</Link>
        </Button>
      </div>
    </AuthLayout>
  );
}
