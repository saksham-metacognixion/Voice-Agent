'use client';

import type { AdminCustomerDetail } from '@portal/schemas';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@portal/ui';
import { Copyable } from '@/src/components/common/copyable';
import { Fact, FactGrid } from '@/src/components/common/query-states';
import { YesNo } from '@/src/components/common/status-badges';
import { formatCents, formatCredits, formatDateTime, formatNumber } from '@/src/lib/format';

export function OverviewTab({ c }: { c: AdminCustomerDetail }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <FactGrid columns={2}>
            <Fact label="Timezone">{c.timezone}</Fact>
            <Fact label="Website" wrap>
              {c.website ?? '–'}
            </Fact>
            <Fact label="Onboarding">{c.onboarding_completed_at ? `Complete ${formatDateTime(c.onboarding_completed_at)}` : `Step ${c.onboarding_step} of 7`}</Fact>
            <Fact label="Members">{formatNumber(c.members, 0)}</Fact>
            <Fact label="Agents">
              {c.agents_live} live / {c.agents_total}
            </Fact>
            <Fact label="Numbers active">{formatNumber(c.numbers_active, 0)}</Fact>
            <Fact label="Calls 30d">{formatNumber(c.calls_30d, 0)}</Fact>
            <Fact label="Usage 30d">{formatCredits(c.usage_30d)} credits</Fact>
            <Fact label="Last activity">{formatDateTime(c.last_activity_at)}</Fact>
            <Fact label="Paused at">{formatDateTime(c.paused_at)}</Fact>
            <Fact label="Paused reason" wrap>
              {c.paused_reason ?? '–'}
            </Fact>
            <Fact label="Open alerts">{c.open_alerts ? <Badge variant="warning">{c.open_alerts}</Badge> : '0'}</Fact>
            <Fact label="View-as sessions open">{c.impersonations_open}</Fact>
            <Fact label="Flags" wrap>
              {c.flags.length ? c.flags.join(', ') : '–'}
            </Fact>
          </FactGrid>
        </CardContent>
      </Card>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Plan and caps</CardTitle>
          </CardHeader>
          <CardContent>
            <FactGrid columns={2}>
              <Fact label="Plan tier">{c.plan_tier}</Fact>
              <Fact label="Concurrency cap">{c.concurrency_cap}</Fact>
              <Fact label="KB allowance">{c.kb_allowance}</Fact>
              <Fact label="Custom deal">
                <YesNo value={c.custom_deal} />
              </Fact>
            </FactGrid>
            {c.overrides ? (
              <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
                <p className="mb-2 font-medium">Tenant overrides</p>
                <FactGrid columns={2}>
                  <Fact label="Concurrency cap">{c.overrides.concurrency_cap ?? '–'}</Fact>
                  <Fact label="KB allowance">{c.overrides.kb_allowance ?? '–'}</Fact>
                  <Fact label="Max agents">{c.overrides.max_agents ?? '–'}</Fact>
                  <Fact label="Max numbers">{c.overrides.max_numbers ?? '–'}</Fact>
                  <Fact label="Reason" wrap>
                    {c.overrides.reason ?? '–'}
                  </Fact>
                  <Fact label="Updated">{formatDateTime(c.overrides.updated_at)}</Fact>
                </FactGrid>
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">No tenant overrides.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Billing</CardTitle>
          </CardHeader>
          <CardContent>
            <FactGrid columns={2}>
              <Fact label="Balance">{formatCredits(c.balance)} credits</Fact>
              <Fact label="Last pack">{c.last_pack_credits === null ? '–' : `${formatCredits(c.last_pack_credits)} credits`}</Fact>
              <Fact label="Paid purchases">{c.purchases_paid}</Fact>
              <Fact label="Lifetime sales">{formatCents(c.lifetime_sales_cents)}</Fact>
              <Fact label="Auto top-up">
                <YesNo value={c.auto_topup_enabled} yes="On" no="Off" />
              </Fact>
              <Fact label="Stripe customer" wrap>
                {c.stripe_customer_id ? <Copyable value={c.stripe_customer_id} full /> : '–'}
              </Fact>
            </FactGrid>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
