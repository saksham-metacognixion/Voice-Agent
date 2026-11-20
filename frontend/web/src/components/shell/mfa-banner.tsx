'use client';

import { Alert, Button } from '@portal/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { currentPathWithQuery } from '@/src/lib/query-string';
import { routes, withNext } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * §6.2 (ADR 0036): the money-at-risk MFA rule binds this person in this workspace and this
 * session has not passed a factor. Shown above the dashboard and the wizard alike — a Scale
 * buyer is over the threshold the moment the pack lands, still inside onboarding (W4).
 */
export function MfaBanner() {
  const t = useTranslations();
  const workspace = useWorkspace().workspace;
  if (!workspace?.mfa.required || workspace.mfa.satisfied) return null;
  return (
    <Alert
      variant="warning"
      title={t('shell.mfaBanner.title')}
      actions={
        <Button size="sm" asChild>
          <Link href={withNext(routes.mfa, currentPathWithQuery())}>{t('shell.mfaBanner.action')}</Link>
        </Button>
      }
    >
      {workspace.mfa.reasons.includes('auto_topup') ? t('shell.mfaBanner.auto_topup') : t('shell.mfaBanner.balance')}
    </Alert>
  );
}
