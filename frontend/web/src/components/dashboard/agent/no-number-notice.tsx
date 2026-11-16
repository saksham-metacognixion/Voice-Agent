'use client';

import type { AgentSummary } from '@portal/schemas';
import { Alert, Button } from '@portal/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { agentNeedsNumber } from '@/src/dashboard/agent-reach';
import { addNumberPath } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';

/**
 * D3, above the tabs: a published agent with no number says so and offers the way to
 * get one. Buying a number is owner/admin (`POST /numbers/buy`), so an editor or a
 * viewer is told who to ask instead of being sent to a page with no Add button.
 */
export function NoNumberNotice({ agent }: { agent: Pick<AgentSummary, 'id' | 'status' | 'numbers_attached'> }) {
  const t = useTranslations('dashboard.agents.noNumber');
  const { canAdmin } = useRole();
  if (!agentNeedsNumber(agent)) return null;
  return (
    <Alert
      variant="warning"
      title={t('title')}
      data-testid="agent-no-number"
      actions={
        canAdmin ? (
          <Button size="sm" asChild>
            <Link href={addNumberPath(agent.id)}>{t('add')}</Link>
          </Button>
        ) : undefined
      }
    >
      {canAdmin ? t('body') : t('askAdmin')}
    </Alert>
  );
}
