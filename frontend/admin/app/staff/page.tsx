'use client';

import { Tabs, TabsList, TabsTrigger } from '@portal/ui';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { LimitsTab } from '@/src/components/staff/limits-tab';
import { MembersTab } from '@/src/components/staff/members-tab';
import { pickParam, setParam, useUrlQuery } from '@/src/lib/use-url-query';
import { STAFF_TABS } from '@/src/routes';

/** SA13 Staff & settings (admin §4, D13): who has console access, and the admin §2.2 limits matrix. */
export default function StaffPage() {
  return (
    <AdminShell>
      <Staff />
    </AdminShell>
  );
}

function Staff() {
  const [params, setQuery] = useUrlQuery();
  const tab = pickParam(params, 'tab', STAFF_TABS, 'members');
  return (
    <>
      <PageHeader title="Staff" crumbs={[{ label: 'Staff' }]} description="Console access and the per-role limits (SA13)." />
      <Tabs value={tab} onValueChange={(v) => setQuery((n) => setParam(n, 'tab', v === 'members' ? null : v))}>
        <TabsList>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="limits">Role limits</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'members' ? <MembersTab /> : <LimitsTab />}
    </>
  );
}
