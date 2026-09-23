'use client';

import { Button, EmptyState } from '@portal/ui';
import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { WizardHeading } from '@/src/components/wizard/wizard-shell';
import { OnboardingStepGuard } from '@/src/guards/guards';
import { routes } from '@/src/routes';

/** W5 placeholder — lands in D9. The guard still applies so nobody skips ahead. */
export default function Page() {
  const t = useTranslations();
  return (
    <OnboardingStepGuard step={5}>
      <WizardHeading title={t('wizard.placeholder.title', { step: t('wizard.steps.test') })} />
      <EmptyState
        icon={<Sparkles />}
        title={t('common.comingSoon')}
        description={t('wizard.placeholder.body')}
        action={
          <Button asChild>
            <Link href={routes.app.home}>{t('wizard.placeholder.dashboard')}</Link>
          </Button>
        }
      />
    </OnboardingStepGuard>
  );
}
