'use client';

import { useApi, useGetWorkspaceChecklist } from '@portal/api-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Progress, Skeleton, cn } from '@portal/ui';
import { Check, Circle } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { LoadError } from '@/src/components/dashboard/query-states';
import { checklistRows } from '@/src/dashboard/home-view';

/**
 * D1 setup checklist (spec p. 33): `GET /workspace/checklist`, computed server-side from
 * the real rows (agent, version with a prompt, publish, paid purchase, number, a
 * forwarding test, an invitation), never from what the browser remembers. Each row links
 * to where it is done. Hidden once every row that applies is done (`all_done`, ADR 0041)
 * — not once the wizard's gate is passed, or "Forwarding tested" and "Invite your team"
 * would never be seen.
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
  if (checklist.data.all_done) return null;
  const { rows, done, total } = checklistRows(checklist.data);

  return (
    <Card data-testid="checklist">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('progress', { done, total })}</CardDescription>
        <Progress value={(done / Math.max(1, total)) * 100} className="mt-2" aria-label={t('title')} />
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.key}>
              <Link href={row.href} data-testid={`checklist-${row.key}`} data-done={row.done} className={cn('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/60', row.done && 'text-muted-foreground')}>
                {row.done ? <Check className="size-4 shrink-0 text-success" aria-hidden /> : <Circle className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />}
                <span className={cn(row.done && 'line-through decoration-muted-foreground/50')}>{t(`steps.${row.key}`)}</span>
              </Link>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
