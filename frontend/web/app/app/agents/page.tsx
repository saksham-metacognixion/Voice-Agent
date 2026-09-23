'use client';

import { EmptyState } from '@portal/ui';
import { BookOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/src/components/shell/portal-shell';

export default function Page() {
  const t = useTranslations();
  return (
    <>
      <PageHeader title={t('dashboard.agents.title')} />
      <EmptyState icon={<BookOpen />} title={t('dashboard.agents.empty' as never) === 'dashboard.agents.empty' ? t('dashboard.comingSoon') : t('dashboard.agents.empty' as never)} />
    </>
  );
}
