'use client';

import { EmptyState } from '@portal/ui';
import { Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/src/components/shell/portal-shell';

export default function Page() {
  const t = useTranslations();
  return (
    <>
      <PageHeader title={t('dashboard.numbers.title')} />
      <EmptyState icon={<Phone />} title={t('dashboard.numbers.empty' as never) === 'dashboard.numbers.empty' ? t('dashboard.comingSoon') : t('dashboard.numbers.empty' as never)} />
    </>
  );
}
