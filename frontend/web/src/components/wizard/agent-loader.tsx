'use client';

import { useApi, useGetAgent } from '@portal/api-client';
import type { AgentDetail } from '@portal/schemas';
import { Button, ErrorState, PageLoader } from '@portal/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';
import { routes } from '@/src/routes';
import { useOnboardingAgent } from '@/src/wizard/use-onboarding-agent';

/**
 * W4–W7 and the live page all work on the agent W1 created: the newest one in the
 * workspace, with its draft. Loads it, shows the loader or the error, and sends someone
 * with no agent yet back to W1 — the same rules W3's loader follows.
 */
export function OnboardingAgentLoader({ children }: { children: (agent: AgentDetail) => React.ReactNode }) {
  const t = useTranslations();
  const api = useApi();
  const router = useRouter();
  const { agent: summary, query } = useOnboardingAgent();
  const detail = useGetAgent(api, { id: summary?.id ?? '' }, { enabled: Boolean(summary?.id) });

  React.useEffect(() => {
    if (summary === null) router.replace(routes.onboarding.template);
  }, [summary, router]);

  if (query.isError) return <ErrorState title={t('errors.loadFailed')} description={errorMessage(query.error, t)} action={<Button onClick={() => void query.refetch()}>{t('common.retry')}</Button>} />;
  if (detail.isError) return <ErrorState title={t('errors.loadFailed')} description={errorMessage(detail.error, t)} action={<Button onClick={() => void detail.refetch()}>{t('common.retry')}</Button>} />;
  if (!summary || !detail.data) return <PageLoader label={t('common.loading')} />;
  return <React.Fragment key={detail.data.id}>{children(detail.data)}</React.Fragment>;
}
