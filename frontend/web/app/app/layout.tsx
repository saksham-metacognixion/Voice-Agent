'use client';

import { PortalShell } from '@/src/components/shell/portal-shell';
import { AppGuard, RequireWorkspace } from '@/src/guards/guards';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireWorkspace>
      <AppGuard>
        <PortalShell>{children}</PortalShell>
      </AppGuard>
    </RequireWorkspace>
  );
}
