'use client';

import { EmptyState } from '@portal/ui';
import { HelpCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/src/components/shell/portal-shell';

export default function HelpPage() {
  const t = useTranslations();
  return (
    <>
      <PageHeader title={t('dashboard.help.title')} />
      <EmptyState icon={<HelpCircle />} title={t('dashboard.help.body')} />
    </>
  );
}
