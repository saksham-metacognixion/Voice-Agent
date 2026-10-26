'use client';

import { useAdminStaffLimits, useAdminUpdateStaffLimits, useApi } from '@portal/api-client';
import { staffRole, type StaffLimits, type StaffLimitsMatrix, type StaffRole } from '@portal/schemas';
import { Alert, Button, Checkbox, Field, Input, Skeleton, Textarea, cn, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import { ConfirmDialog } from '@/src/components/common/confirm-dialog';
import { PermissionButton } from '@/src/components/common/permission-button';
import { LoadError } from '@/src/components/common/query-states';
import { formatDateTime } from '@/src/lib/format';
import { ROLE_LABELS } from '@/src/lib/permissions';
import { useStaff } from '@/src/staff/staff-provider';

const ROLES: StaffRole[] = staffRole.options;

type NumericKey = 'credit_adjust_max_per_action' | 'credit_adjust_max_per_day' | 'refund_max_cents';
type BooleanKey = Exclude<keyof StaffLimits, NumericKey>;

/** Admin §2.2, row by row, in the matrix's order. */
const NUMERIC: Array<{ key: NumericKey; label: string; unit: string }> = [
  { key: 'credit_adjust_max_per_action', label: 'Credit adjustment, per action', unit: 'credits' },
  { key: 'credit_adjust_max_per_day', label: 'Credit adjustment, per day', unit: 'credits' },
  { key: 'refund_max_cents', label: 'Refund, per purchase', unit: 'cents' },
];
const BOOLEAN: Array<{ key: BooleanKey; label: string }> = [
  { key: 'can_listen_recordings', label: 'Listen to recordings' },
  { key: 'can_change_plan', label: 'Change a plan' },
  { key: 'can_pause_tenant', label: 'Pause a workspace' },
  { key: 'can_edit_pricing_draft', label: 'Edit the pricing draft' },
  { key: 'can_publish_pricing', label: 'Publish pricing' },
  { key: 'can_edit_agent_stack', label: 'Edit the agent stack' },
  { key: 'can_publish_agent_stack', label: 'Publish the agent stack' },
  { key: 'can_manage_flags', label: 'Flags and kill switches' },
  { key: 'can_view_as_customer', label: 'View as a customer' },
  { key: 'can_act_as_customer', label: 'Act as a customer (P2)' },
  { key: 'can_delete_customer_data', label: 'Delete customer data' },
  { key: 'can_manage_staff', label: 'Manage staff' },
  { key: 'can_export', label: 'Export' },
];

/** The grid's editable copy: numbers as the text in their inputs, so a half-typed value survives a render. */
type Draft = Record<StaffRole, { numbers: Record<NumericKey, string>; flags: Record<BooleanKey, boolean> }>;

function toDraft(m: StaffLimitsMatrix): Draft {
  return Object.fromEntries(
    ROLES.map((role) => [
      role,
      {
        numbers: Object.fromEntries(NUMERIC.map((n) => [n.key, m[role][n.key] === null ? '' : String(m[role][n.key])])) as Record<NumericKey, string>,
        flags: Object.fromEntries(BOOLEAN.map((b) => [b.key, m[role][b.key]])) as Record<BooleanKey, boolean>,
      },
    ]),
  ) as Draft;
}

/** Blank = unlimited (null). Anything that is not a non-negative number is invalid. */
function parseNumber(text: string, integer: boolean): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) return undefined;
  return n;
}

function fromDraft(d: Draft): { matrix: StaffLimitsMatrix; invalid: string[] } {
  const invalid: string[] = [];
  const matrix = Object.fromEntries(
    ROLES.map((role) => {
      const numbers = Object.fromEntries(
        NUMERIC.map((n) => {
          const v = parseNumber(d[role].numbers[n.key], n.key === 'refund_max_cents');
          if (v === undefined) invalid.push(`${ROLE_LABELS[role]} · ${n.label}`);
          return [n.key, v ?? null];
        }),
      );
      return [role, { ...numbers, ...d[role].flags }];
    }),
  ) as StaffLimitsMatrix;
  return { matrix, invalid };
}

function describe(key: NumericKey | BooleanKey, value: number | boolean | null): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value === null) return 'unlimited';
  return key === 'refund_max_cents' ? `$${(value / 100).toFixed(2)}` : String(value);
}

/** Every cell that differs between two matrices, as a sentence each — the Save dialog's summary. */
export function diffMatrices(before: StaffLimitsMatrix, after: StaffLimitsMatrix): string[] {
  const lines: string[] = [];
  for (const role of ROLES) {
    for (const n of NUMERIC) if (before[role][n.key] !== after[role][n.key]) lines.push(`${ROLE_LABELS[role]} · ${n.label}: ${describe(n.key, before[role][n.key])} → ${describe(n.key, after[role][n.key])}`);
    for (const b of BOOLEAN) if (before[role][b.key] !== after[role][b.key]) lines.push(`${ROLE_LABELS[role]} · ${b.label}: ${describe(b.key, before[role][b.key])} → ${describe(b.key, after[role][b.key])}`);
  }
  return lines;
}

/** SA13 Role limits: the admin §2.2 matrix as an editable grid, saved whole with a diff to confirm. */
export function LimitsTab() {
  const api = useApi();
  const limits = useAdminStaffLimits(api, { staleTime: 10_000 });
  if (limits.isPending) return <Skeleton className="h-96" aria-busy />;
  if (limits.isError) return <LoadError error={limits.error} onRetry={() => void limits.refetch()} />;
  return <LimitsGrid key={limits.data.updated_at ?? 'seed'} matrix={limits.data.limits} updatedAt={limits.data.updated_at} />;
}

function LimitsGrid({ matrix, updatedAt }: { matrix: StaffLimitsMatrix; updatedAt: string | null }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { me, can, refetch } = useStaff();
  const denied = can.manageStaff();
  const save = useAdminUpdateStaffLimits(api);
  const [draft, setDraft] = React.useState<Draft>(() => toDraft(matrix));
  const [confirming, setConfirming] = React.useState(false);
  const [note, setNote] = React.useState('');

  const { matrix: next, invalid } = React.useMemo(() => fromDraft(draft), [draft]);
  const changes = React.useMemo(() => (invalid.length ? [] : diffMatrices(matrix, next)), [matrix, next, invalid.length]);
  const lockout = !next.super_admin.can_manage_staff;
  const readOnly = Boolean(denied);

  const setNumber = (role: StaffRole, key: NumericKey, value: string) => setDraft((d) => ({ ...d, [role]: { ...d[role], numbers: { ...d[role].numbers, [key]: value } } }));
  const setFlag = (role: StaffRole, key: BooleanKey, value: boolean) => setDraft((d) => ({ ...d, [role]: { ...d[role], flags: { ...d[role].flags, [key]: value } } }));

  async function commit() {
    await save.mutateAsync({ body: { limits: next, note: note.trim() || undefined } });
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['adminStaffLimits'] }), refetch()]);
    toast.success('Role limits saved', { description: `${changes.length} change${changes.length === 1 ? '' : 's'}; every staff member gets them on their next request.` });
    setNote('');
  }

  const th = 'px-3 py-2 text-xs font-medium text-muted-foreground';
  const mine = (role: StaffRole) => role === me.role;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Enforced server-side on every write (admin §2.2, §10). A blank cap means no ceiling. Your column ({ROLE_LABELS[me.role]}) is highlighted.
          {updatedAt ? <span className="block text-xs">Last changed {formatDateTime(updatedAt)}.</span> : null}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setDraft(toDraft(matrix))} disabled={!changes.length && !invalid.length}>
            Reset
          </Button>
          <PermissionButton size="sm" denied={denied} disabled={!changes.length || invalid.length > 0 || lockout} onClick={() => setConfirming(true)}>
            Save {changes.length ? `(${changes.length})` : ''}
          </PermissionButton>
        </div>
      </div>
      {lockout ? <Alert variant="danger">The super admin role must keep “Manage staff”, or nobody could change these limits again.</Alert> : null}
      {invalid.length ? <Alert variant="warning">Not a valid cap: {invalid.join(', ')}. Use a non-negative number, or leave it blank for no ceiling.</Alert> : null}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full text-left text-sm" aria-label="Role limits">
          <thead className="bg-muted/60">
            <tr>
              <th scope="col" className={cn(th, 'min-w-56')}>
                Capability
              </th>
              {ROLES.map((role) => (
                <th key={role} scope="col" className={cn(th, 'text-center whitespace-nowrap', mine(role) && 'bg-primary/10 text-accent-foreground')}>
                  {ROLE_LABELS[role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {NUMERIC.map((n) => (
              <tr key={n.key}>
                <th scope="row" className="px-3 py-2 font-normal">
                  {n.label} <span className="text-xs text-muted-foreground">({n.unit})</span>
                </th>
                {ROLES.map((role) => {
                  const text = draft[role].numbers[n.key];
                  const bad = parseNumber(text, n.key === 'refund_max_cents') === undefined;
                  return (
                    <td key={role} className={cn('px-2 py-1.5', mine(role) && 'bg-primary/5')}>
                      <Input inputMode="decimal" value={text} onChange={(e) => setNumber(role, n.key, e.target.value)} placeholder="unlimited" aria-label={`${ROLE_LABELS[role]} ${n.label}`} aria-invalid={bad || undefined} invalid={bad} readOnly={readOnly} className="h-8 min-w-24 text-right tabular-nums" />
                    </td>
                  );
                })}
              </tr>
            ))}
            {BOOLEAN.map((b) => (
              <tr key={b.key}>
                <th scope="row" className="px-3 py-2 font-normal">
                  {b.label}
                </th>
                {ROLES.map((role) => (
                  <td key={role} className={cn('px-2 py-1.5 text-center', mine(role) && 'bg-primary/5')}>
                    <Checkbox checked={draft[role].flags[b.key]} onCheckedChange={(v) => setFlag(role, b.key, v === true)} disabled={readOnly} aria-label={`${ROLE_LABELS[role]} ${b.label}`} className="mx-auto" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Save role limits"
        description="Every staff member gets the new limits on their next request. The whole matrix is written and audited as one change."
        consequences={changes}
        confirmLabel={`Save ${changes.length} change${changes.length === 1 ? '' : 's'}`}
        destructive={false}
        onConfirm={commit}
      >
        <Field id="limits-note" label="Note" optional description="Goes in the staff audit log.">
          <Textarea id="limits-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
