'use client';

import { useApi, useGetAgentWidget, useGetNotificationSettings, useListMembers } from '@portal/api-client';
import type { AgentDetail, PhoneNumberResponse } from '@portal/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from '@portal/ui';
import { Check, Circle } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { agentPath, numberPath, settingsPath } from '@/src/routes';
import { liveChecklist, type LiveChecklistKey } from '@/src/wizard/live-checklist';

/**
 * §8 W7b "Next-steps checklist: invite a teammate, turn on daily digest, add your
 * website widget" (Z-56), plus forwarding for an Option B number. Each row links to
 * where it is done and is ticked from the rows the API holds (`liveChecklist`), never
 * from this page's memory, so a refresh shows the truth. Hidden rows do not exist: a
 * bought number has no forwarding to test.
 */
export function NextStepsChecklist({ agent, number }: { agent: AgentDetail; number: PhoneNumberResponse | null | undefined }) {
  const t = useTranslations('wizard.live.next');
  const api = useApi();
  const members = useListMembers(api, { staleTime: 30_000 });
  const notifications = useGetNotificationSettings(api, { staleTime: 30_000 });
  const widget = useGetAgentWidget(api, { id: agent.id }, { staleTime: 30_000 });
  const items = liveChecklist({ number, members: members.data, notifications: notifications.data, widget: widget.data });
  const href: Record<LiveChecklistKey, string> = {
    forwarding: number ? numberPath(number.id, 'forwarding') : settingsPath('workspace'),
    invite_team: settingsPath('team'),
    daily_digest: settingsPath('notifications'),
    website_widget: agentPath(agent.id, 'website'),
  };
  const loading = members.isPending || notifications.isPending || widget.isPending;
  const done = items.filter((i) => i.done).length;

  return (
    <Card data-testid="next-steps">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{loading ? t('checking') : t('progress', { done, total: items.length })}</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-1" aria-busy={loading || undefined}>
          {items.map((item) => (
            <li key={item.key}>
              <Link href={href[item.key]} className={cn('flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/60', item.done && 'text-muted-foreground')} data-testid={`next-step-${item.key}`} data-done={item.done || undefined}>
                {item.done ? <Check className="size-4 shrink-0 text-success" aria-hidden /> : <Circle className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />}
                <span className="flex min-w-0 flex-col">
                  <span className={cn('font-medium', item.done && 'line-through decoration-muted-foreground/50')}>{t(`items.${item.key}.title`)}</span>
                  <span className="text-xs text-muted-foreground">{t(`items.${item.key}.${item.done ? 'done' : 'body'}`)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
