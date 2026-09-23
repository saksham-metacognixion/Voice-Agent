'use client';

import { EmptyState } from '@portal/ui';
import { Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/src/components/shell/portal-shell';

export default function Page() {
  const t = useTranslations();
  return (
    <>
      <PageHeader title={t('dashboard.wallet.title')} />
      <EmptyState icon={<Wallet />} title={t('dashboard.wallet.empty' as never) === 'dashboard.wallet.empty' ? t('dashboard.comingSoon') : t('dashboard.wallet.empty' as never)} />
    </>
  );
}
