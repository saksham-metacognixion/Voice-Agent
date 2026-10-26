'use client';

import { useAdminImpersonate, useAdminPauseCustomer, useAdminResumeCustomer, useApi } from '@portal/api-client';
import { IMPERSONATE_NOTE_MAX, type AdminCustomerDetail, type StaffActionRequest } from '@portal/schemas';
import { Badge, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import * as React from 'react';
import { PageHeader } from '@/src/components/shell/page-header';
import { Copyable } from '@/src/components/common/copyable';
import { PermissionButton } from '@/src/components/common/permission-button';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { CustomerStatusBadge, PlanBadge } from '@/src/components/common/status-badges';
import { BalanceCell } from '@/src/components/customers/customers-table';
import { AdjustCreditsDialog } from '@/src/components/customers/adjust-credits-dialog';
import { config } from '@/src/config';
import { formatDate } from '@/src/lib/format';
import { routes } from '@/src/routes';
import { useStaff } from '@/src/staff/staff-provider';

/** SA2 header: identity, plan, balance, status, and the three quick actions. */
export function CustomerHeader({ c }: { c: AdminCustomerDetail }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can, refetch } = useStaff();
  const pause = useAdminPauseCustomer(api);
  const resume = useAdminResumeCustomer(api);
  const impersonate = useAdminImpersonate(api);
  const [adjusting, setAdjusting] = React.useState(false);
  const [pausing, setPausing] = React.useState(false);
  const [resuming, setResuming] = React.useState(false);
  const [viewing, setViewing] = React.useState(false);
  const paused = c.status === 'paused' || Boolean(c.paused_at);

  async function invalidate() {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['adminGetCustomer'] }), queryClient.invalidateQueries({ queryKey: ['adminListCustomers'] })]);
  }

  async function doPause(body: StaffActionRequest) {
    await pause.mutateAsync({ params: { id: c.id }, body });
    await invalidate();
    toast.success(`${c.name} paused`);
  }
  async function doResume(body: StaffActionRequest) {
    await resume.mutateAsync({ params: { id: c.id }, body });
    await invalidate();
    toast.success(`${c.name} resumed`);
  }

  // The reason is the staff member's, chosen in the dialog (admin Appendix B), never a default.
  async function viewAs(body: StaffActionRequest) {
    // Open the tab synchronously so the browser does not treat the post-await open as a popup.
    const tab = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    try {
      const session = await impersonate.mutateAsync({ params: { id: c.id }, body: { ...body, mode: 'view' } });
      const url = session.portal_url ?? `${config.portalUrl}/app/`;
      if (tab) tab.location.href = url;
      else window.open(url, '_blank', 'noopener');
      await queryClient.invalidateQueries({ queryKey: ['adminMe'] });
      await refetch();
      await invalidate();
      toast.success(`Viewing ${c.name} as read-only`, { description: 'Exit from the banner when you are done.' });
    } catch (e) {
      tab?.close();
      throw e;
    }
  }

  return (
    <>
      <PageHeader
        title={c.name}
        crumbs={[{ label: 'Customers', href: routes.customers }, { label: c.name }]}
        description={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Copyable value={c.id} full />
            <PlanBadge tier={c.plan_tier} />
            <CustomerStatusBadge status={c.status} />
            <span>
              Balance <BalanceCell balance={c.balance} lastPack={c.last_pack_credits} />
            </span>
            <span>{c.country}</span>
            <span>Owner {c.owner_email ?? '–'}</span>
            <span>Since {formatDate(c.created_at)}</span>
            {c.custom_deal ? <Badge variant="premium">Custom deal</Badge> : null}
            {paused && c.paused_reason ? <Badge variant="warning">Paused: {c.paused_reason}</Badge> : null}
          </div>
        }
        actions={
          <>
            <PermissionButton variant="outline" size="sm" denied={can.viewAs()} onClick={() => setViewing(true)} loading={impersonate.isPending}>
              <Eye /> View as
            </PermissionButton>
            <PermissionButton variant="outline" size="sm" denied={can.adjustCredits()} onClick={() => setAdjusting(true)}>
              Adjust credits
            </PermissionButton>
            {paused ? (
              <PermissionButton size="sm" denied={can.pauseTenant()} onClick={() => setResuming(true)}>
                Resume
              </PermissionButton>
            ) : (
              <PermissionButton variant="danger-outline" size="sm" denied={can.pauseTenant()} onClick={() => setPausing(true)}>
                Pause
              </PermissionButton>
            )}
          </>
        }
      />
      {adjusting ? <AdjustCreditsDialog customerId={c.id} customerName={c.name} balance={c.balance} onClose={() => setAdjusting(false)} /> : null}
      <StaffActionDialog
        open={pausing}
        onOpenChange={setPausing}
        title={`Pause ${c.name}`}
        description="Admin §4 SA2 — the workspace stops answering and stops changing."
        consequences={['Every number declines inbound calls (busy tone, no charge).', 'Generate, feedback and publish refuse; test calls refuse.', 'Members can still sign in and read their dashboard.', 'The wallet, lots and rentals are untouched.']}
        confirmLabel="Pause workspace"
        destructive
        typeToConfirm={c.name}
        typeLabel="Type the customer name to confirm"
        onConfirm={doPause}
      />
      <StaffActionDialog open={resuming} onOpenChange={setResuming} title={`Resume ${c.name}`} consequences={['Numbers answer again; generate and publish work again.']} confirmLabel="Resume workspace" onConfirm={doResume} />
      <StaffActionDialog
        open={viewing}
        onOpenChange={setViewing}
        title={`View ${c.name} as read-only`}
        description="Admin §7.4 — the portal opens in a new tab as the workspace owner would see it."
        consequences={['Every screen is read-only; no write goes through, and recordings are refused.', 'The session lasts one hour and is audited at both ends, with this reason.', 'Exit from the banner when you are done.']}
        confirmLabel="Open portal"
        noteMax={IMPERSONATE_NOTE_MAX}
        onConfirm={viewAs}
      />
    </>
  );
}
