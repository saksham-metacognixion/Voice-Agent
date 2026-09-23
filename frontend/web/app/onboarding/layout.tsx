'use client';

import { WizardShell } from '@/src/components/wizard/wizard-shell';
import { RequireWorkspace } from '@/src/guards/guards';

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireWorkspace>
      <WizardShell>{children}</WizardShell>
    </RequireWorkspace>
  );
}
