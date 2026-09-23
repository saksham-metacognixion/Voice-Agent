'use client';

import { EmptyState } from '@portal/ui';
import { LayoutDashboard } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/src/components/shell/portal-shell';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/** D1 Home — the widgets land in D10; the shell, banners and balance are live now. */
export default function HomePage() {
  const t = useTranslations();
  const ws = useWorkspace();
  return (
    <>
      <PageHeader title={t('dashboard.home.title')} description={ws.workspace ? t('dashboard.home.welcome', { workspace: ws.workspace.name }) : undefined} />
      <EmptyState icon={<LayoutDashboard />} title={t('dashboard.home.body')} />
    </>
  );
}
