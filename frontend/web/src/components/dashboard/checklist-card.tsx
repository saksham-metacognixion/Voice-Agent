'use client';

import { useApi, useGetWorkspaceChecklist } from '@portal/api-client';
import type { WorkspaceChecklist } from '@portal/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Progress, Skeleton, cn } from '@portal/ui';
import { Check, Circle } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LoadError } from '@/src/components/dashboard/query-states';
import { routes } from '@/src/routes';

type Step = { key: keyof Omit<WorkspaceChecklist, 'onboarding_step' | 'complete'>; href: string };

/** §6.4 as the server computes it, in wizard order. Each row links to where it is done. */
const STEPS: Step[] = [
  { key: 'workspace_created', href: routes.app.settings },
  { key: 'agent_created', href: routes.app.agents },
  { key: 'agent_generated', href: routes.app.agents },
  { key: 'agent_published', href: routes.app.agents },
  { key: 'credits_purchased', href: routes.app.wallet },
  { key: 'number_attached', href: routes.app.numbers },
];

/**
 * D1 setup checklist (spec p. 33): `GET /workspace/checklist`, computed server-side from
 * the real rows (agent, version with a prompt, publish, paid purchase, number), never
 * from what the browser remembers. Hidden once everything is done.
 */
export function ChecklistCard() {
  const t = useTranslations('dashboard.home.checklist');
  const api = useApi();
  const checklist = useGetWorkspaceChecklist(api, { staleTime: 30_000 });

  if (checklist.isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2" aria-busy>
          <Skeleton className="h-2 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (checklist.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <LoadError compact error={checklist.error} onRetry={() => void checklist.refetch()} />
        </CardContent>
      </Card>
    );
  }
  if (checklist.data.complete) return null;
  const done = STEPS.filter((s) => checklist.data[s.key]).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('progress', { done, total: STEPS.length })}</CardDescription>
        <Progress value={(done / STEPS.length) * 100} className="mt-2" aria-label={t('title')} />
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-1">
          {STEPS.map((step) => {
            const ok = checklist.data[step.key];
            return (
              <li key={step.key}>
                <Link href={step.href} className={cn('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/60', ok && 'text-muted-foreground')}>
                  {ok ? <Check className="size-4 shrink-0 text-success" aria-hidden /> : <Circle className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />}
                  <span className={cn(ok && 'line-through decoration-muted-foreground/50')}>{t(`steps.${step.key}`)}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
