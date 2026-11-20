'use client';

import { AdminShell } from '@/src/components/shell/admin-shell';
import { PlaceholderPage } from '@/src/components/common/placeholder-page';

export default function Page() {
  return (
    <AdminShell>
      <PlaceholderPage title="Comms" />
    </AdminShell>
  );
}
