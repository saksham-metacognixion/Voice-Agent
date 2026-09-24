'use client';

import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, ThemeSegment, Button } from '@portal/ui';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/src/auth/auth-provider';
import { PageHeader } from '@/src/components/shell/portal-shell';
import { routes } from '@/src/routes';

/** D6 Settings — appearance and security entry points now; the rest lands in D11. */
export default function SettingsPage() {
  const t = useTranslations();
  // Same source as A5's badge: the `mfa_enrolled` ID-token claim, or `amr` on the
  // sign-in that enrolled. Without it this card offered setup to people already enrolled.
  const mfaOn = useAuth().user?.mfa === true;
  return (
    <>
      <PageHeader title={t('dashboard.settings.title')} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('dashboard.settings.theme')}</CardTitle>
            <CardDescription>{t('dashboard.settings.themeHint')}</CardDescription>
          </CardHeader>
          <CardContent>
            <ThemeSegment labels={{ light: t('common.theme.light'), dark: t('common.theme.dark'), system: t('common.theme.system'), toggle: t('common.theme.toggle') }} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>{t('dashboard.settings.security')}</CardTitle>
              <Badge variant={mfaOn ? 'success' : 'outline'}>{mfaOn ? t('auth.mfa.enabled') : t('auth.mfa.notEnabled')}</Badge>
            </div>
            <CardDescription>{mfaOn ? t('auth.mfa.onHint') : t('auth.mfa.body')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" asChild>
              <Link href={routes.mfa}>
                <ShieldCheck /> {t('auth.mfa.title')}
              </Link>
            </Button>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('dashboard.settings.workspace')}</CardTitle>
            <CardDescription>{t('dashboard.comingSoon')}</CardDescription>
          </CardHeader>
          <CardContent />
        </Card>
      </div>
    </>
  );
}
