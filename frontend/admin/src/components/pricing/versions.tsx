'use client';

import { useAdminGetPricingVersion, useAdminPricingVersions, useAdminRollbackPricing, useApi } from '@portal/api-client';
import { PRICING_NOTE_MAX, type AdminPricingVersion } from '@portal/schemas';
import { Badge, Checkbox, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { CellActions, DataTable, type DataColumn } from '@/src/components/common/data-table';
import { DetailSheet } from '@/src/components/common/detail-sheet';
import { JsonView } from '@/src/components/common/json-view';
import { PermissionButton } from '@/src/components/common/permission-button';
import { Fact, FactGrid, LoadError } from '@/src/components/common/query-states';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { StripeSyncBadge } from '@/src/components/common/status-badges';
import { formatDateTime, humanize } from '@/src/lib/format';
import { useStaff } from '@/src/staff/staff-provider';

/** SA5 Versions: history, rollback (a new version from an old config), and a detail drawer. */
export function PricingVersions() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const denied = can.publishPricing();
  const versions = useAdminPricingVersions(api);
  const rollback = useAdminRollbackPricing(api);
  const [open, setOpen] = React.useState<number | null>(null);
  const [rolling, setRolling] = React.useState<AdminPricingVersion | null>(null);
  const [override, setOverride] = React.useState(false);

  if (versions.isPending) return <Skeleton className="h-64" aria-busy />;
  if (versions.isError) return <LoadError error={versions.error} onRetry={() => void versions.refetch()} />;

  const columns: Array<DataColumn<AdminPricingVersion>> = [
    { key: 'version', header: 'Version', cell: (r) => <span className="flex items-center gap-2 font-medium">v{r.version}{r.is_current ? <Badge variant="success">current</Badge> : null}</span> },
    { key: 'effective', header: 'Effective', cell: (r) => <span className="whitespace-nowrap">{formatDateTime(r.effective_at)}</span> },
    { key: 'published', header: 'Published', cell: (r) => <span className="whitespace-nowrap text-muted-foreground">{formatDateTime(r.published_at)}{r.published_by_email ? ` · ${r.published_by_email}` : ''}</span> },
    { key: 'summary', header: 'Summary', cell: (r) => (r.change_summary ? <span className="block max-w-72 truncate" title={r.change_summary}>{r.change_summary}</span> : <span className="text-muted-foreground">–</span>) },
    { key: 'grandfather', header: 'Grandfather', cell: (r) => (r.grandfather_mode ? humanize(r.grandfather_mode) : '–') },
    { key: 'packs', header: 'Packs', align: 'right', cell: (r) => r.packs },
    {
      key: 'stripe',
      header: 'Stripe sync',
      cell: (r) => (
        <span className="flex flex-col gap-0.5">
          <StripeSyncBadge status={r.stripe_sync.status} />
          {r.stripe_sync.error ? <span className="max-w-56 truncate text-xs text-danger" title={r.stripe_sync.error}>{r.stripe_sync.error}</span> : null}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <CellActions>
          {!r.is_current && r.effective_at ? (
            <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setRolling(r)}>
              Roll back to v{r.version}
            </PermissionButton>
          ) : null}
        </CellActions>
      ),
    },
  ];

  return (
    <>
      <DataTable rows={versions.data} columns={columns} rowKey={(r) => String(r.version)} label="Pricing versions" onRowClick={(r) => setOpen(r.version)} />
      <VersionSheet version={open} onClose={() => setOpen(null)} />
      <StaffActionDialog
        open={Boolean(rolling)}
        onOpenChange={(o) => {
          if (!o) {
            setRolling(null);
            setOverride(false);
          }
        }}
        title={`Roll back to v${rolling?.version ?? ''}`}
        description="Publishes that version's config as a new version, effective now, with a Stripe sync. Publish's checks apply: a pack bought in the last 12 months cannot be removed, and the margin floor needs an override with a note."
        consequences={['Existing customers keep their current rates until their next purchase.', 'The current draft is discarded.']}
        confirmLabel="Roll back"
        destructive
        typeToConfirm="ROLLBACK"
        noteMax={PRICING_NOTE_MAX}
        onConfirm={async (body) => {
          if (!rolling) return;
          const v = await rollback.mutateAsync({ params: { version: String(rolling.version) }, body: { ...body, override_margin: override } });
          await Promise.all([queryClient.invalidateQueries({ queryKey: ['adminPricingVersions'] }), queryClient.invalidateQueries({ queryKey: ['adminPricingPreview'] }), queryClient.invalidateQueries({ queryKey: ['adminPricingDraft'] })]);
          toast.success(`Rolled back: v${v.version} published from v${rolling.version}`);
          setOverride(false);
        }}
      >
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={override} onCheckedChange={(v) => setOverride(v === true)} /> Override the margin floor if it blocks (super admin; the note says why)
        </label>
      </StaffActionDialog>
    </>
  );
}

function VersionSheet({ version, onClose }: { version: number | null; onClose: () => void }) {
  const api = useApi();
  const detail = useAdminGetPricingVersion(api, { version: String(version ?? '') }, { enabled: version !== null });
  const d = detail.data;
  return (
    <DetailSheet open={version !== null} onOpenChange={(o) => (o ? undefined : onClose())} title={`Pricing v${version ?? ''}`} description={d?.change_summary ?? undefined}>
      {detail.isPending ? (
        <Skeleton className="h-64" />
      ) : detail.isError ? (
        <LoadError error={detail.error} onRetry={() => void detail.refetch()} compact />
      ) : !d ? null : (
        <>
          <FactGrid columns={2}>
            <Fact label="Current">{d.is_current ? 'Yes' : 'No'}</Fact>
            <Fact label="Effective">{formatDateTime(d.effective_at)}</Fact>
            <Fact label="Published">{formatDateTime(d.published_at)}</Fact>
            <Fact label="By">{d.published_by_email ?? '–'}</Fact>
            <Fact label="Grandfather">{d.grandfather_mode ? humanize(d.grandfather_mode) : '–'}</Fact>
            <Fact label="Stripe sync">
              <StripeSyncBadge status={d.stripe_sync.status} />
            </Fact>
            <Fact label="Synced at">{formatDateTime(d.stripe_sync.synced_at)}</Fact>
            <Fact label="Sync error" wrap>
              <span className="text-danger">{d.stripe_sync.error ?? '–'}</span>
            </Fact>
          </FactGrid>
          {d.stripe_sync.prices.length ? (
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Stripe prices</p>
              <ul className="divide-y divide-border rounded-md border border-border text-xs">
                {d.stripe_sync.prices.map((p) => (
                  <li key={`${p.pack_id}-${p.currency}`} className="flex flex-wrap gap-2 px-2 py-1 font-mono">
                    <span>{p.pack_id}</span>
                    <span className="text-muted-foreground">{p.currency}</span>
                    <span className="text-muted-foreground">{p.stripe_price_id}</span>
                    {!p.active ? <Badge variant="outline">archived</Badge> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Config</p>
            <JsonView value={d.config} />
          </div>
        </>
      )}
    </DetailSheet>
  );
}
