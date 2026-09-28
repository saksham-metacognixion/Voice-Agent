'use client';

import { isApiError, useAdminPricingPreview, useAdminPublishPricing, useApi } from '@portal/api-client';
import type { AdminPricingPreviewResponse } from '@portal/schemas';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, Field, Input, Label, RadioGroup, RadioCard, Skeleton, Textarea, cn, toast,
} from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { PermissionButton } from '@/src/components/common/permission-button';
import { LoadError } from '@/src/components/common/query-states';
import { errorMessage } from '@/src/lib/errors';
import { formatNumber, formatPercent, humanize, localInputToIso } from '@/src/lib/format';
import { prettyJson } from '@/src/lib/json';
import { useStaff } from '@/src/staff/staff-provider';

/** SA5 Preview: what publish would change, the margins, the Stripe plan, and the blockers. */
export function PricingPreview({ onPublished }: { onPublished: () => void }) {
  const api = useApi();
  const preview = useAdminPricingPreview(api, { staleTime: 5_000 });
  const [publishing, setPublishing] = React.useState(false);
  const { can } = useStaff();
  const denied = can.publishPricing();
  if (preview.isPending) return <Skeleton className="h-96" aria-busy />;
  if (preview.isError) return <LoadError error={preview.error} onRetry={() => void preview.refetch()} />;
  const p = preview.data;
  if (!p.has_draft) return <EmptyState title="No draft to preview" description="Save changes on the Draft tab first." />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm">
        <span>
          Publishing creates <Badge variant="primary">v{p.next_version}</Badge> from <Badge variant="outline">v{p.current_version}</Badge>
        </span>
        <span className="ml-auto">
          <PermissionButton denied={denied} onClick={() => setPublishing(true)} disabled={p.blockers.some((b) => !isMarginBlocker(b))}>
            Publish v{p.next_version}
          </PermissionButton>
        </span>
      </div>

      {p.blockers.length ? (
        <Alert variant="danger" title="Publish is blocked">
          <ul className="list-disc pl-5">
            {p.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {p.warnings.length ? (
        <Alert variant="warning" title="Warnings">
          <ul className="list-disc pl-5">
            {p.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Changes ({p.changes.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {p.changes.length ? (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Path</th>
                    <th className="px-3 py-2 font-medium">Before</th>
                    <th className="px-3 py-2 font-medium">After</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {p.changes.map((c) => (
                    <tr key={c.path}>
                      <td className="px-3 py-1.5 font-mono text-xs">{c.path}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{short(c.before)}</td>
                      <td className="px-3 py-1.5 font-mono text-xs">{short(c.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">The draft is identical to the current version.</p>
          )}
          <div className="mt-3 flex flex-wrap gap-4 text-xs">
            <PackList label="Packs added" items={p.packs.added} variant="success" />
            <PackList label="Packs removed" items={p.packs.removed} variant="danger" />
            <PackList label="Packs changed" items={p.packs.changed} variant="info" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Margins (admin §5.4)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 text-right font-medium">Revenue ¢/min</th>
                  <th className="px-3 py-2 text-right font-medium">Cost ¢/min</th>
                  <th className="px-3 py-2 text-right font-medium">Margin</th>
                  <th className="px-3 py-2 text-right font-medium">Floor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {p.margins.map((m) => (
                  <tr key={m.tier} className={cn(m.below_floor && 'bg-danger/5')}>
                    <td className="px-3 py-1.5">{humanize(m.tier)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(m.revenue_cents_per_min, 2)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{m.cost_cents_per_min === null ? <span className="text-muted-foreground">not set</span> : formatNumber(m.cost_cents_per_min, 2)}</td>
                    <td className={cn('px-3 py-1.5 text-right tabular-nums', m.below_floor && 'font-semibold text-danger')}>{formatPercent(m.margin_pct)}{m.below_floor ? ' ↓' : ''}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{formatPercent(m.floor_pct, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Stripe ({p.stripe.length} planned action{p.stripe.length === 1 ? '' : 's'})</CardTitle>
        </CardHeader>
        <CardContent>
          {p.stripe.length ? (
            <ul className="divide-y divide-border text-sm">
              {p.stripe.map((s, i) => (
                <li key={`${s.pack_id}-${s.currency}-${i}`} className="flex items-center gap-3 py-1.5">
                  <Badge variant={s.action === 'create' ? 'success' : s.action === 'archive' ? 'warning' : 'outline'}>{s.action}</Badge>
                  <span className="font-mono text-xs">
                    {s.pack_id} · {s.currency}
                  </span>
                  <span className="text-muted-foreground">{s.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No Stripe changes.</p>
          )}
        </CardContent>
      </Card>

      {publishing ? <PublishDialog preview={p} onClose={() => setPublishing(false)} onPublished={onPublished} /> : null}
    </div>
  );
}

function isMarginBlocker(b: string): boolean {
  return /margin/i.test(b);
}

function short(v: unknown): string {
  const s = prettyJson(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function PackList({ label, items, variant }: { label: string; items: string[]; variant: 'success' | 'danger' | 'info' }) {
  if (!items.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="text-muted-foreground">{label}:</span>
      {items.map((i) => (
        <Badge key={i} variant={variant}>
          {i}
        </Badge>
      ))}
    </span>
  );
}

/** Admin §5.2 publish: effective date, grandfather mode, summary, margin override, typed PUBLISH. */
function PublishDialog({ preview, onClose, onPublished }: { preview: AdminPricingPreviewResponse; onClose: () => void; onPublished: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const publish = useAdminPublishPricing(api);
  const [effective, setEffective] = React.useState('');
  const [mode, setMode] = React.useState<'keep_until_next_purchase' | 'apply_now'>('keep_until_next_purchase');
  const [summary, setSummary] = React.useState('');
  const [override, setOverride] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [typed, setTyped] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [stripeFailed, setStripeFailed] = React.useState<string | null>(null);
  const marginBlocked = preview.blockers.some(isMarginBlocker);
  const ok = typed.trim().toUpperCase() === 'PUBLISH' && (!marginBlocked || (override && note.trim().length > 0));

  async function run() {
    if (!ok) return;
    setError(null);
    setStripeFailed(null);
    try {
      const v = await publish.mutateAsync({ body: { effective_at: localInputToIso(effective), grandfather_mode: mode, change_summary: summary.trim() || undefined, override_margin: override, note: note.trim() || undefined } });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['adminPricingDraft'] }),
        queryClient.invalidateQueries({ queryKey: ['adminPricingPreview'] }),
        queryClient.invalidateQueries({ queryKey: ['adminPricingVersions'] }),
      ]);
      toast.success(`Pricing v${v.version} published`, { description: v.stripe_sync.status === 'synced' ? 'Stripe prices synced.' : `Stripe sync: ${v.stripe_sync.status}` });
      onClose();
      onPublished();
    } catch (e) {
      if (isApiError(e, 'STRIPE_SYNC_FAILED')) {
        await queryClient.invalidateQueries({ queryKey: ['adminPricingVersions'] });
        setStripeFailed(e.body.message);
      } else {
        setError(errorMessage(e));
      }
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o || publish.isPending ? undefined : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Publish pricing v{preview.next_version}</DialogTitle>
          <DialogDescription>A new version, then the Stripe price sync, then it takes effect and every cache drops (admin §5.2).</DialogDescription>
        </DialogHeader>
        {stripeFailed ? (
          <Alert variant="danger" title="Stripe sync failed — the version is NOT in effect">
            <p>{stripeFailed}</p>
            <p className="mt-1">The version was saved with its Stripe sync marked failed. Fix the cause and publish again: the sync resumes from where it stopped and nothing is created twice.</p>
          </Alert>
        ) : null}
        <Field id="pub-effective" label="Effective at" optional description="Empty = now. A future time schedules it.">
          <Input id="pub-effective" type="datetime-local" value={effective} onChange={(e) => setEffective(e.target.value)} className="max-w-64" />
        </Field>
        <Field label="Existing customers">
          <RadioGroup value={mode} onValueChange={(v) => setMode(v as typeof mode)} className="grid gap-2 sm:grid-cols-2">
            <RadioCard value="keep_until_next_purchase" title="Keep until next purchase" description="Current rates and caps stay until they buy again." />
            <RadioCard value="apply_now" title="Apply now" description="New rates and caps at the effective time." />
          </RadioGroup>
        </Field>
        <Field id="pub-summary" label="Change summary" optional>
          <Textarea id="pub-summary" value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} maxLength={500} className="min-h-16" placeholder="What changed and why — shown on the Versions tab." />
        </Field>
        {marginBlocked ? (
          <div className="flex flex-col gap-2 rounded-md border border-danger/40 bg-danger/5 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Checkbox checked={override} onCheckedChange={(v) => setOverride(v === true)} /> Override the margin floor (super admin)
            </label>
            <Field id="pub-note" label="Note" required description="Why publishing below the floor is acceptable.">
              <Textarea id="pub-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className="min-h-16" disabled={!override} />
            </Field>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pub-typed">
            Type <span className="font-mono">PUBLISH</span> to confirm
          </Label>
          <Input id="pub-typed" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={publish.isPending}>
            {stripeFailed ? 'Close' : 'Cancel'}
          </Button>
          <Button onClick={() => void run()} disabled={!ok || publish.isPending} loading={publish.isPending}>
            {stripeFailed ? 'Publish again (resume sync)' : `Publish v${preview.next_version}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
