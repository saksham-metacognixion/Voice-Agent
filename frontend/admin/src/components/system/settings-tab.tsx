'use client';

import { useAdminGetSettings, useAdminUpdateSettings, useApi } from '@portal/api-client';
import type { AdminSettingsResponse, PlatformSettingKey, PlatformSettings, StaffActionRequest } from '@portal/schemas';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { PermissionButton } from '@/src/components/common/permission-button';
import { LoadError } from '@/src/components/common/query-states';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { formatDateTime } from '@/src/lib/format';
import { useStaff } from '@/src/staff/staff-provider';

/** A setting is a number in a range, or (with `options`) one of a few named values. */
const FIELDS: Array<{ key: PlatformSettingKey; label: string; description: string; unit: string; blank?: string; min: number; max: number; integer: boolean; options?: Array<{ value: string; label: string }> }> = [
  { key: 'concurrency_platform_limit', label: 'Platform concurrency allowance', description: 'Calls the voice platform plan lets us run at once. Ops is paged as live calls near it.', unit: 'calls', blank: 'Not monitored', min: 1, max: 100_000, integer: true },
  { key: 'concurrency_alert_pct', label: 'Concurrency alert threshold', description: 'Share of a cap — a workspace’s, or the allowance — at which the alert opens.', unit: '%', min: 1, max: 100, integer: true },
  { key: 'reconcile_drift_threshold_pct', label: 'Reconciliation drift threshold', description: 'The nightly reconciliation pages ops when our calls and the platform’s differ by more than this.', unit: '%', min: 0, max: 100, integer: false },
  // ADR 0049: how a CAD price is derived from the USD price. Pricing → Currencies shows the result.
  { key: 'fx_refresh_interval_hours', label: 'Exchange rate: refresh every', description: 'Time between successful reads of the USD/CAD rate. 24 is once a day.', unit: 'hours', min: 1, max: 168, integer: true },
  { key: 'fx_stale_after_days', label: 'Exchange rate: stale after', description: 'Ops is alerted once the rate in force is this old. It stays in force.', unit: 'days', min: 1, max: 30, integer: true },
  { key: 'fx_max_move_pct', label: 'Exchange rate: largest move accepted', description: 'A new rate further than this from the stored one is refused and ops alerted.', unit: '%', min: 1, max: 50, integer: true },
  { key: 'cad_rounding_step_cents', label: 'CAD price: round to', description: 'A converted price is rounded to a multiple of this. 100 is a whole dollar.', unit: 'cents', min: 1, max: 10_000, integer: true },
  {
    key: 'cad_rounding_mode',
    label: 'CAD price: rounding',
    description: 'Which way a converted price goes to reach the step.',
    unit: '',
    min: 0,
    max: 0,
    integer: false,
    options: [
      { value: 'nearest', label: 'Nearest (half up)' },
      { value: 'up', label: 'Always up' },
      { value: 'down', label: 'Always down' },
    ],
  },
];

const SOURCE_LABEL = { console: 'Set here', env: 'Environment', default: 'Default' } as const;

/**
 * Admin §9 platform settings: the knobs that used to need an environment variable and a
 * redeploy. Each shows where its value comes from; "Reset" removes the console value so
 * the environment variable (or the default) applies again.
 */
export function SettingsTab() {
  const api = useApi();
  const q = useAdminGetSettings(api, { staleTime: 15_000 });
  if (q.isPending) return <Skeleton className="h-64" aria-busy />;
  if (q.isError) return <LoadError error={q.error} onRetry={() => void q.refetch()} />;
  return <SettingsForm s={q.data} />;
}

function SettingsForm({ s }: { s: AdminSettingsResponse }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const update = useAdminUpdateSettings(api);
  const initial = React.useCallback(() => Object.fromEntries(FIELDS.map((f) => [f.key, s.settings[f.key]?.toString() ?? ''])) as Record<PlatformSettingKey, string>, [s]);
  const [values, setValues] = React.useState(initial);
  React.useEffect(() => setValues(initial()), [initial]);
  const [pending, setPending] = React.useState<{ set: Partial<Record<PlatformSettingKey, number | string | null>>; reset: PlatformSettingKey[] } | null>(null);
  const denied = can.operateQueues();

  const parsed = (f: (typeof FIELDS)[number]): number | string | null | undefined => {
    const raw = values[f.key].trim();
    if (f.options) return f.options.some((o) => o.value === raw) ? raw : undefined;
    if (raw === '') return f.blank ? null : undefined;
    const v = Number(raw);
    return Number.isFinite(v) && v >= f.min && v <= f.max && (!f.integer || Number.isInteger(v)) ? v : undefined;
  };
  const changed = Object.fromEntries(FIELDS.filter((f) => parsed(f) !== undefined && parsed(f) !== s.settings[f.key]).map((f) => [f.key, parsed(f)])) as Partial<Record<PlatformSettingKey, number | string | null>>;
  const invalid = FIELDS.some((f) => parsed(f) === undefined);

  async function confirm(body: StaffActionRequest) {
    if (!pending) return;
    // Only the allowance takes null; the field rules above never yield it for the others.
    await update.mutateAsync({ body: { ...body, ...(pending.set as Partial<PlatformSettings>), ...(pending.reset.length ? { reset: pending.reset } : {}) } });
    await Promise.all(['adminGetSettings', 'adminConcurrency', 'adminKpis', 'adminPricingFx'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    toast.success(pending.reset.length ? 'Setting reset' : 'Settings saved', { description: 'Schedules read the new values within a minute.' });
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 pb-0">
        <div>
          <CardTitle className="text-sm">Platform settings</CardTitle>
          <CardDescription className="text-xs">{s.updated_at ? `Last changed ${formatDateTime(s.updated_at)}${s.updated_by_email ? ` by ${s.updated_by_email}` : ''}` : 'Nothing set here yet: environment variables and defaults apply.'}</CardDescription>
        </div>
        <PermissionButton size="sm" denied={denied ?? (invalid ? 'Fix the highlighted values first.' : Object.keys(changed).length ? null : 'Change a value first.')} onClick={() => setPending({ set: changed, reset: [] })}>
          Save changes
        </PermissionButton>
      </CardHeader>
      <CardContent className="grid gap-5 pt-4 md:grid-cols-3">
        {FIELDS.map((f) => (
          <div key={f.key} className="flex flex-col gap-2">
            <Field
              id={`setting-${f.key}`}
              label={f.label}
              description={f.description}
              error={parsed(f) === undefined ? (f.options ? 'Choose one of the options.' : `${f.integer ? 'A whole number' : 'A number'} from ${f.min} to ${f.max.toLocaleString('en-US')}${f.blank ? ', or blank' : ''}.`) : undefined}
              addon={<Badge variant={s.source[f.key] === 'console' ? 'primary' : 'outline'}>{SOURCE_LABEL[s.source[f.key] ?? 'default']}</Badge>}
            >
              {f.options ? (
                <Select value={values[f.key]} onValueChange={(v) => setValues((all) => ({ ...all, [f.key]: v }))} disabled={Boolean(denied)}>
                  <SelectTrigger id={`setting-${f.key}`} className="max-w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {f.options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex items-center gap-2">
                  <Input id={`setting-${f.key}`} inputMode="decimal" value={values[f.key]} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} placeholder={f.blank} className="max-w-36" invalid={parsed(f) === undefined} disabled={Boolean(denied)} />
                  <span className="text-sm text-muted-foreground">{f.unit}</span>
                </div>
              )}
            </Field>
            {s.source[f.key] === 'console' ? (
              <PermissionButton size="sm" variant="ghost" className="self-start" denied={denied} onClick={() => setPending({ set: {}, reset: [f.key] })}>
                Reset to {SOURCE_LABEL.env.toLowerCase()} / default
              </PermissionButton>
            ) : null}
          </div>
        ))}
      </CardContent>
      <StaffActionDialog
        open={Boolean(pending)}
        onOpenChange={(o) => (o ? undefined : setPending(null))}
        title={pending?.reset.length ? 'Reset a setting' : 'Save platform settings'}
        consequences={
          pending
            ? [
                ...Object.entries(pending.set).map(([k, v]) => `${FIELDS.find((f) => f.key === k)?.label}: ${v === null ? 'not monitored' : (FIELDS.find((f) => f.key === k)?.options?.find((o) => o.value === v)?.label ?? v)}`),
                ...pending.reset.map((k) => `${FIELDS.find((f) => f.key === k)?.label}: back to the environment variable or default`),
              ]
            : []
        }
        confirmLabel={pending?.reset.length ? 'Reset' : 'Save'}
        onConfirm={confirm}
      />
    </Card>
  );
}
