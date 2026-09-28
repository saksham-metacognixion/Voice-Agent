'use client';

import { useAdminGetCustomer, useApi } from '@portal/api-client';
import { EmptyState, Skeleton, Tabs, TabsList, TabsTrigger } from '@portal/ui';
import Link from 'next/link';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { LoadError } from '@/src/components/common/query-states';
import { CustomerHeader } from '@/src/components/customers/customer-header';
import { AgentsTab, AuditTab, CallsTab, JobsTab, NumbersTab, WebhooksTab } from '@/src/components/customers/tabs/list-tabs';
import { MembersTab } from '@/src/components/customers/tabs/members-tab';
import { OverviewTab } from '@/src/components/customers/tabs/overview-tab';
import { PurchasesTab } from '@/src/components/customers/tabs/purchases-tab';
import { WalletTab } from '@/src/components/customers/tabs/wallet-tab';
import { humanize } from '@/src/lib/format';
import { pickParam, setParam, useUrlQuery } from '@/src/lib/use-url-query';
import { CUSTOMER_TABS, routes } from '@/src/routes';

export default function CustomerDetailPage() {
  return (
    <AdminShell>
      <CustomerDetail />
    </AdminShell>
  );
}

/** SA2 Customer 360: `/customers/detail/?id=&tab=` (the spec's `[id]` flattened for the export). */
function CustomerDetail() {
  const api = useApi();
  const [params, setQuery] = useUrlQuery();
  const id = params.get('id') ?? '';
  const tab = pickParam(params, 'tab', CUSTOMER_TABS, 'overview');
  const customer = useAdminGetCustomer(api, { id }, { enabled: Boolean(id), refetchInterval: 60_000 });

  if (!id) return <EmptyState title="No customer selected" action={<Link href={routes.customers} className="text-sm text-primary underline">Back to customers</Link>} />;
  if (customer.isPending) return <Skeleton className="h-48" aria-busy />;
  if (customer.isError) return <LoadError error={customer.error} onRetry={() => void customer.refetch()} />;
  const c = customer.data;

  return (
    <>
      <CustomerHeader c={c} />
      <Tabs value={tab} onValueChange={(v) => setQuery((n) => setParam(n, 'tab', v === 'overview' ? null : v))}>
        <TabsList>
          {CUSTOMER_TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {humanize(t)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === 'overview' ? <OverviewTab c={c} /> : null}
      {tab === 'members' ? <MembersTab customerId={id} /> : null}
      {tab === 'wallet' ? <WalletTab customerId={id} customerName={c.name} /> : null}
      {tab === 'purchases' ? <PurchasesTab customerId={id} /> : null}
      {tab === 'agents' ? <AgentsTab customerId={id} /> : null}
      {tab === 'numbers' ? <NumbersTab customerId={id} /> : null}
      {tab === 'calls' ? <CallsTab customerId={id} /> : null}
      {tab === 'jobs' ? <JobsTab customerId={id} /> : null}
      {tab === 'webhooks' ? <WebhooksTab customerId={id} /> : null}
      {tab === 'audit' ? <AuditTab customerId={id} /> : null}
    </>
  );
}
