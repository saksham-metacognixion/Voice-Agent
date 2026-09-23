'use client';

import { EmptyState } from '@portal/ui';
import { PhoneCall } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/src/components/shell/portal-shell';

export default function Page() {
  const t = useTranslations();
  return (
    <>
      <PageHeader title={t('dashboard.calls.title')} />
      <EmptyState icon={<PhoneCall />} title={t('dashboard.calls.empty' as never) === 'dashboard.calls.empty' ? t('dashboard.comingSoon') : t('dashboard.calls.empty' as never)} />
    </>
  );
}
