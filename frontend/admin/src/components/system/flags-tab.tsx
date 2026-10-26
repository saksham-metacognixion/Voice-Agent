'use client';

import { useAdminDeleteFlag, useAdminListFlags, useAdminSetKillSwitch, useAdminUpsertFlag, useApi } from '@portal/api-client';
import { FLAG_KEY_PATTERN, adminUpsertFlagRequest, type AdminFeatureFlag, type AdminKillSwitch, type ReasonCode, type StaffActionRequest } from '@portal/schemas';
import {
  Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, Input, Skeleton, Switch, Textarea, cn, toast,
} from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { DataTable, type DataColumn, CellActions } from '@/src/components/common/data-table';
import { PermissionButton } from '@/src/components/common/permission-button';
import { LoadError } from '@/src/components/common/query-states';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime, localInputToIso, relativeTime } from '@/src/lib/format';
import { useStaff } from '@/src/staff/staff-provider';

/** SA12 Flags tab: feature flags with inline edit, and the four kill switches as cards. */
export function FlagsTab() {
  const api = useApi();
  const flags = useAdminListFlags(api, { staleTime: 10_000 });
  if (flags.isPending) return <Skeleton className="h-64" aria-busy />;
  if (flags.isError) return <LoadError error={flags.error} onRetry={() => void flags.refetch()} />;
  return (
    <div className="flex flex-col gap-8">
      <KillSwitches switches={flags.data.kill_switches} />
      <FeatureFlags flags={flags.data.flags} />
    </div>
  );
}

// ---------------------------------------------------------------------------- kill switches

function KillSwitches({ switches }: { switches: AdminKillSwitch[] }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const denied = can.manageFlags();
  const set = useAdminSetKillSwitch(api);
  const [turningOn, setTurningOn] = React.useState<AdminKillSwitch | null>(null);
  const [turningOff, setTurningOff] = React.useState<AdminKillSwitch | null>(null);
  const [expires, setExpires] = React.useState('');

  async function invalidate() {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['adminListFlags'] }), queryClient.invalidateQueries({ queryKey: ['adminSystemHealth'] })]);
  }

  async function turnOn(body: StaffActionRequest) {
    if (!turningOn) return;
    // The card's reason line is derived by the API from the code and note.
    await set.mutateAsync({ params: { key: turningOn.key }, body: { ...body, on: true, expires_at: localInputToIso(expires) ?? null } });
    await invalidate();
    toast.success(`${turningOn.key} is ON`);
    setExpires('');
  }

  async function turnOff(body: StaffActionRequest) {
    if (!turningOff) return;
    await set.mutateAsync({ params: { key: turningOff.key }, body: { ...body, on: false } });
    await invalidate();
    toast.success(`${turningOff.key} is off`);
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">Kill switches</h2>
      <div className="grid gap-4 md:grid-cols-2">
        {switches.map((s) => (
          <Card key={s.key} className={cn(s.active && 'border-danger/60 bg-danger/5')}>
            <CardHeader className="flex-row items-start justify-between gap-3 pb-0">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <code>{s.key}</code>
                  {s.active ? <Badge variant="danger">ACTIVE</Badge> : s.on ? <Badge variant="warning">on (expired)</Badge> : null}
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
              </div>
              {denied ? (
                <PermissionButton size="sm" variant="outline" denied={denied}>
                  {s.on ? 'Turn off' : 'Turn on'}
                </PermissionButton>
              ) : (
                <Switch checked={s.on} onCheckedChange={(v) => (v ? setTurningOn(s) : setTurningOff(s))} aria-label={`${s.key} ${s.on ? 'on' : 'off'}`} />
              )}
            </CardHeader>
            <CardContent className="pt-3 text-xs text-muted-foreground">
              {s.on ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <dt>Reason</dt>
                  <dd className="text-foreground">{s.reason ?? '–'}</dd>
                  <dt>Set by</dt>
                  <dd className="truncate text-foreground">{s.set_by_email ?? s.set_by ?? '–'}</dd>
                  <dt>Expires</dt>
                  <dd className="text-foreground">{s.expires_at ? `${formatDateTime(s.expires_at)} (${relativeTime(s.expires_at)})` : 'never'}</dd>
                  <dt>Updated</dt>
                  <dd className="text-foreground">{formatDateTime(s.updated_at)}</dd>
                </dl>
              ) : (
                <p>Off{s.updated_at ? ` · last changed ${relativeTime(s.updated_at)}` : ''}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
      <StaffActionDialog
        open={Boolean(turningOn)}
        onOpenChange={(o) => (o ? undefined : setTurningOn(null))}
        title={`Turn on ${turningOn?.key ?? ''}`}
        description={turningOn?.description}
        consequences={KILL_CONSEQUENCES[turningOn?.key ?? ''] ?? ['Takes effect within seconds on every API instance.']}
        confirmLabel="Turn on"
        destructive
        typeToConfirm={turningOn?.key}
        onConfirm={turnOn}
      >
        <Field id="ks-expires" label="Expires" optional description="Leave empty to keep it on until someone turns it off.">
          <Input id="ks-expires" type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} className="max-w-64" />
        </Field>
      </StaffActionDialog>
      <StaffActionDialog
        open={Boolean(turningOff)}
        onOpenChange={(o) => (o ? undefined : setTurningOff(null))}
        title={`Turn off ${turningOff?.key ?? ''}`}
        description="Normal behaviour resumes within seconds."
        confirmLabel="Turn off"
        onConfirm={turnOff}
      />
    </section>
  );
}

const KILL_CONSEQUENCES: Record<string, string[]> = {
  reject_inbound: ['Every inbound call on every number gets a busy tone — before any other check.', 'Republished to the hot path immediately; no call is charged while it is on.'],
  pause_web_tests: ['W5 and D3 test calls answer 409 TESTS_PAUSED.', 'Live phone calls are unaffected.'],
  pause_purchases: ['Checkout and auto top-up refuse to start.', 'Purchases already in flight still settle.'],
  pause_generation: ['Generate, feedback and regenerate refuse; queued jobs are held.', 'Publishing an already generated version still works.'],
};

// ---------------------------------------------------------------------------- feature flags

function FeatureFlags({ flags }: { flags: AdminFeatureFlag[] }) {
  const { can } = useStaff();
  const denied = can.manageFlags();
  const [editing, setEditing] = React.useState<AdminFeatureFlag | 'new' | null>(null);
  const [deleting, setDeleting] = React.useState<AdminFeatureFlag | null>(null);
  const api = useApi();
  const queryClient = useQueryClient();
  const del = useAdminDeleteFlag(api);

  const columns: Array<DataColumn<AdminFeatureFlag>> = [
    { key: 'key', header: 'Flag', cell: (r) => <code className="text-xs">{r.key}</code> },
    { key: 'desc', header: 'Description', cell: (r) => r.description ?? <span className="text-muted-foreground">–</span> },
    { key: 'default', header: 'Default', cell: (r) => <Badge variant={r.default_on ? 'success' : 'outline'}>{r.default_on ? 'on' : 'off'}</Badge> },
    { key: 'rollout', header: 'Rollout', align: 'right', cell: (r) => `${r.rollout_pct}%` },
    // D13 QA: "default off" with a 100 % rollout is on for everyone — say what a workspace actually gets.
    { key: 'effective', header: 'Effective', cell: (r) => (r.default_on ? 'on for everyone' : r.rollout_pct >= 100 ? 'on for everyone (rollout)' : r.rollout_pct > 0 ? `on for ${r.rollout_pct}% of workspaces` : 'off') },
    { key: 'overrides', header: 'Overrides', align: 'right', cell: (r) => Object.keys(r.tenant_overrides).length },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <CellActions>
          <PermissionButton size="sm" variant="outline" denied={denied} onClick={() => setEditing(r)}>
            Edit
          </PermissionButton>
          <PermissionButton size="icon-sm" variant="ghost" denied={denied} onClick={() => setDeleting(r)} aria-label={`Delete ${r.key}`}>
            <Trash2 />
          </PermissionButton>
        </CellActions>
      ),
    },
  ];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Feature flags</h2>
        <PermissionButton size="sm" denied={denied} onClick={() => setEditing('new')}>
          <Plus /> Add flag
        </PermissionButton>
      </div>
      {flags.length ? <DataTable rows={flags} columns={columns} rowKey={(r) => r.key} label="Feature flags" dense /> : <p className="text-sm text-muted-foreground">No feature flags defined.</p>}
      {editing ? <FlagDialog flag={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
      <StaffActionDialog
        open={Boolean(deleting)}
        onOpenChange={(o) => (o ? undefined : setDeleting(null))}
        title={`Delete flag ${deleting?.key ?? ''}`}
        consequences={['Every workspace reads the flag as absent (off) within 60 s.', 'Tenant overrides on it are lost.']}
        confirmLabel="Delete flag"
        destructive
        typeToConfirm={deleting?.key}
        onConfirm={async (body) => {
          if (!deleting) return;
          await del.mutateAsync({ params: { key: deleting.key }, body });
          await queryClient.invalidateQueries({ queryKey: ['adminListFlags'] });
          toast.success(`${deleting.key} deleted`);
        }}
      />
    </section>
  );
}

function FlagDialog({ flag, onClose }: { flag: AdminFeatureFlag | null; onClose: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const upsert = useAdminUpsertFlag(api);
  const [key, setKey] = React.useState(flag?.key ?? '');
  const [description, setDescription] = React.useState(flag?.description ?? '');
  const [defaultOn, setDefaultOn] = React.useState(flag?.default_on ?? false);
  // A new flag starts fully off: the resolver turns it on for `rollout_pct` of workspaces even
  // when the default is off, so 100 here would ship the flag to everyone (D13 QA).
  const [rollout, setRollout] = React.useState(String(flag?.rollout_pct ?? 0));
  const [overrides, setOverrides] = React.useState<Array<{ tenant: string; on: boolean }>>(Object.entries(flag?.tenant_overrides ?? {}).map(([tenant, on]) => ({ tenant, on })));
  // No reason until one is chosen (QA-035/QA-041): the audit row records what staff picked.
  const [reason, setReason] = React.useState<ReasonCode | ''>('');
  const [note, setNote] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const keyOk = FLAG_KEY_PATTERN.test(key);
  const pct = Number(rollout);
  const pctOk = Number.isInteger(pct) && pct >= 0 && pct <= 100;
  const noteRequired = reason === 'other';
  const reasonOk = Boolean(reason) && (!noteRequired || Boolean(note.trim()));

  async function save() {
    if (!keyOk || !pctOk || !reasonOk) return;
    setBusy(true);
    setError(null);
    try {
      const tenant_overrides: Record<string, boolean> = {};
      for (const o of overrides) if (o.tenant.trim()) tenant_overrides[o.tenant.trim()] = o.on;
      const body = adminUpsertFlagRequest.parse({ description: description.trim() || null, default_on: defaultOn, rollout_pct: pct, tenant_overrides, reason_code: reason, note: note.trim() || undefined });
      await upsert.mutateAsync({ params: { key }, body });
      await queryClient.invalidateQueries({ queryKey: ['adminListFlags'] });
      toast.success(`${key} saved`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o || busy ? undefined : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{flag ? `Edit ${flag.key}` : 'New feature flag'}</DialogTitle>
          <DialogDescription>Workspaces re-read flags within 60 s.</DialogDescription>
        </DialogHeader>
        {!flag ? (
          <Field id="flag-key" label="Key" required error={key && !keyOk ? 'Lowercase letters, digits and _ ; starts with a letter; 2–64 characters.' : undefined}>
            <Input id="flag-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="e.g. web_widget_beta" autoComplete="off" />
          </Field>
        ) : null}
        <Field id="flag-desc" label="Description" optional>
          <Input id="flag-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field id="flag-default" label="Default on">
            <div className="flex h-10 items-center">
              <Switch id="flag-default" checked={defaultOn} onCheckedChange={setDefaultOn} />
            </div>
          </Field>
          <Field id="flag-rollout" label="Rollout %" description={!defaultOn && pct > 0 ? `Default off, but on for ${pct}% of workspaces.` : undefined} error={!pctOk ? '0–100' : undefined}>
            <Input id="flag-rollout" inputMode="numeric" value={rollout} onChange={(e) => setRollout(e.target.value)} />
          </Field>
        </div>
        <Field label="Tenant overrides" description="Workspace id → forced value. Overrides beat rollout.">
          <div className="flex flex-col gap-2">
            {overrides.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input value={o.tenant} onChange={(e) => setOverrides((all) => all.map((x, j) => (j === i ? { ...x, tenant: e.target.value } : x)))} placeholder="workspace uuid" className="font-mono text-xs" aria-label="Workspace id" />
                <Switch checked={o.on} onCheckedChange={(v) => setOverrides((all) => all.map((x, j) => (j === i ? { ...x, on: v } : x)))} aria-label="Forced on" />
                <Button variant="ghost" size="icon-sm" onClick={() => setOverrides((all) => all.filter((_, j) => j !== i))} aria-label="Remove override">
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="self-start" onClick={() => setOverrides((all) => [...all, { tenant: '', on: true }])}>
              <Plus /> Add override
            </Button>
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field id="flag-reason" label="Reason" required>
            <select id="flag-reason" value={reason} onChange={(e) => setReason(e.target.value as ReasonCode | '')} className="h-10 rounded-md border border-input bg-card px-3 text-sm">
              <option value="" disabled>
                Choose a reason
              </option>
              {(['testing_internal', 'service_issue', 'promo', 'partner_deal', 'customer_request', 'other'] as ReasonCode[]).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field id="flag-note" label="Note" required={noteRequired} optional={!noteRequired} error={noteRequired && !note.trim() ? 'Required with "other".' : undefined}>
            <Textarea id="flag-note" value={note} onChange={(e) => setNote(e.target.value)} rows={1} maxLength={500} className="min-h-10" />
          </Field>
        </div>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!keyOk || !pctOk || !reasonOk || busy} loading={busy}>
            Save flag
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
