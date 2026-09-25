'use client';

import { PageLoader, Tabs, TabsContent, TabsList, TabsTrigger } from '@portal/ui';
import { useTranslations } from 'next-intl';
import { NotificationsTab, PrivacyTab, SecurityTab } from '@/src/components/dashboard/settings/account-tabs';
import { AuditTab } from '@/src/components/dashboard/settings/audit-tab';
import { TeamTab } from '@/src/components/dashboard/settings/team-tab';
import { WorkspaceTab } from '@/src/components/dashboard/settings/workspace-tab';
import { PageHeader } from '@/src/components/shell/portal-shell';
import { setParam, useUrlQuery } from '@/src/lib/use-url-query';
import { SETTINGS_TABS, type SettingsTab } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D6 Settings (spec p. 39): Workspace · Team · Notifications · Security · Data &
 * privacy · Audit log. `/app/settings/*` in the spec; one page with `?tab=` in the
 * export. The audit log is owner/admin only and is not offered to anyone else.
 */
export default function SettingsPage() {
  const t = useTranslations('dashboard.settings');
  const ws = useWorkspace();
  const { canAdmin } = useRole();
  const [params, setParams] = useUrlQuery();
  const tabs = SETTINGS_TABS.filter((tab) => tab !== 'audit' || canAdmin);
  const requested = params.get('tab');
  const active: SettingsTab = (tabs as readonly string[]).includes(requested ?? '') ? (requested as SettingsTab) : 'workspace';
  const workspace = ws.workspace;

  return (
    <>
      <PageHeader title={t('title')} />
      {!workspace ? (
        <PageLoader />
      ) : (
        <Tabs
          value={active}
          onValueChange={(v) =>
            setParams((next) => {
              setParam(next, 'tab', v === 'workspace' ? null : v);
            }, 'replace')
          }
        >
          <TabsList aria-label={t('tabs.label')}>
            {tabs.map((key) => (
              <TabsTrigger key={key} value={key}>
                {t(`tabs.${key}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="workspace">
            <WorkspaceTab workspace={workspace} />
          </TabsContent>
          <TabsContent value="team">
            <TeamTab />
          </TabsContent>
          <TabsContent value="notifications">
            <NotificationsTab />
          </TabsContent>
          <TabsContent value="security">
            <SecurityTab />
          </TabsContent>
          <TabsContent value="privacy">
            <PrivacyTab workspace={workspace} />
          </TabsContent>
          {canAdmin ? (
            <TabsContent value="audit">
              <AuditTab />
            </TabsContent>
          ) : null}
        </Tabs>
      )}
    </>
  );
}
