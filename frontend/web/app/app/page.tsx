'use client';

import { toast } from '@portal/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ActivityChart } from '@/src/components/dashboard/activity-chart';
import { AgentsCard } from '@/src/components/dashboard/agents-card';
import { AlertBanner } from '@/src/components/dashboard/alert-banner';
import { ChecklistCard } from '@/src/components/dashboard/checklist-card';
import { CreditsCard } from '@/src/components/dashboard/credits-card';
import { RecentCallsCard } from '@/src/components/dashboard/recent-calls-card';
import { TodayCard } from '@/src/components/dashboard/today-card';
import { LiveDot } from '@/src/components/dashboard/live-dot';
import { PageHeader } from '@/src/components/shell/portal-shell';
import { useDashboardLive } from '@/src/dashboard/use-dashboard-live';
import { formatPhone } from '@/src/lib/format';
import { callPath } from '@/src/routes';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D1 Home (spec pp. 32–33): the alert banner, credits, today, agents, the setup
 * checklist, recent calls and the 30-day chart — every widget its own query, all of
 * them refreshed by the workspace's SSE stream, so a call that comes in while the page
 * is open shows up in "Today", the chart and the recent list without a reload.
 */
export default function HomePage() {
  const t = useTranslations();
  const ws = useWorkspace();
  const router = useRouter();
  const stream = useDashboardLive({
    onNewCall: (call) => {
      toast(call.missed ? t('dashboard.live.missedCall') : t('dashboard.live.newCall'), {
        description: call.fromNumber ? t('dashboard.live.from', { number: formatPhone(call.fromNumber) }) : undefined,
        action: { label: t('dashboard.live.view'), onClick: () => router.push(callPath(call.callId)) },
      });
    },
  });

  return (
    <>
      <PageHeader
        title={t('dashboard.home.title')}
        description={ws.workspace ? t('dashboard.home.welcome', { workspace: ws.workspace.name }) : undefined}
        actions={<LiveDot state={stream} />}
      />
      <AlertBanner />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
        <CreditsCard />
        <TodayCard />
        <AgentsCard />
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <ActivityChart />
        </div>
        <ChecklistCard />
      </div>
      <RecentCallsCard />
    </>
  );
}
