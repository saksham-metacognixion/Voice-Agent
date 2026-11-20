'use client';

import { EmptyState } from '@portal/ui';
import { Construction } from 'lucide-react';
import { PageHeader } from '@/src/components/shell/page-header';

/** A section the spec lists that D12 does not build (admin §11: P2). */
export function PlaceholderPage({ title, description }: { title: string; description?: string }) {
  return (
    <>
      <PageHeader title={title} crumbs={[{ label: title }]} />
      <EmptyState icon={<Construction />} title="Not built yet" description={description ?? `The ${title} section is planned for a later release.`} />
    </>
  );
}
