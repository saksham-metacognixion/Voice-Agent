'use client';

import { Tabs, TabsList, TabsTrigger } from '@portal/ui';
import { AdminShell } from '@/src/components/shell/admin-shell';
import { PageHeader } from '@/src/components/shell/page-header';
import { CostsTab } from '@/src/components/pricing/costs';
import { DraftEditor } from '@/src/components/pricing/draft-editor';
import { PricingPreview } from '@/src/components/pricing/preview';
import { PricingVersions } from '@/src/components/pricing/versions';
import { pickParam, setParam, useUrlQuery } from '@/src/lib/use-url-query';
import { PRICING_TABS } from '@/src/routes';

export default function PricingPage() {
  return (
    <AdminShell>
      <Pricing />
    </AdminShell>
  );
}

function Pricing() {
  const [params, setQuery] = useUrlQuery();
  const tab = pickParam(params, 'tab', PRICING_TABS, 'draft');
  const go = (t: string) => setQuery((n) => setParam(n, 'tab', t === 'draft' ? null : t));
  return (
    <>
      <PageHeader title="Pricing" crumbs={[{ label: 'Pricing' }]} description="Packs, rates, recurring charges and wallet policy — versioned, previewed, then published with a Stripe sync." />
      <Tabs value={tab} onValueChange={go}>
        <TabsList>
          <TabsTrigger value="draft">Draft</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'draft' ? <DraftEditor /> : null}
      {tab === 'preview' ? <PricingPreview onPublished={() => go('versions')} /> : null}
      {tab === 'versions' ? <PricingVersions /> : null}
      {tab === 'costs' ? <CostsTab /> : null}
    </>
  );
}
