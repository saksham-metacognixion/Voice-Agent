'use client';

import { useAdminRetellCosts, useAdminSaveRetellCosts, useApi } from '@portal/api-client';
import { type RetellCostInputs, retellCostInputs } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { PermissionButton } from '@/src/components/common/permission-button';
import { LoadError } from '@/src/components/common/query-states';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime } from '@/src/lib/format';
import { useStaff } from '@/src/staff/staff-provider';
import { NumField } from './num-field';

/**
 * SA5 Costs: the voice platform's price list, itemised as admin §5 asks (ADR 0038). The
 * margin preview prices each tier from these and the tier's current stack, so a model or a
 * voice missing here shows as "missing" there and blocks a publish until it is added.
 */
export function CostsTab() {
  const api = useApi();
  const costs = useAdminRetellCosts(api);
  if (costs.isPending) return <Skeleton className="h-64" aria-busy />;
  if (costs.isError) return <LoadError error={costs.error} onRetry={() => void costs.refetch()} />;
  return <CostsForm key={costs.data.version ?? 'none'} initial={costs.data.costs} meta={costs.data} />;
}

type Rows = Array<{ key: string; value: number | null }>;
type RateMap = 'tts_cents_per_min' | 'llm_cents_per_min' | 'telephony_cents_per_min' | 'analysis_cents_per_call';

const MAPS: Array<{ name: RateMap; title: string; keyLabel: string; keyHint: string; unit: string }> = [
  { name: 'llm_cents_per_min', title: 'In-call model', keyLabel: 'Model id', keyHint: 'gpt-4.1-mini', unit: '¢ / min' },
  { name: 'tts_cents_per_min', title: 'Voice', keyLabel: 'Provider, or provider:model', keyHint: 'elevenlabs:eleven_flash_v2_5', unit: '¢ / min' },
  { name: 'telephony_cents_per_min', title: 'Telephony on a bought number', keyLabel: 'Country', keyHint: 'US', unit: '¢ / min' },
  { name: 'analysis_cents_per_call', title: 'Post-call analysis', keyLabel: 'Analysis model id', keyHint: 'gpt-5.6-terra', unit: '¢ / call' },
];

// Sorted, so a provider's rows sit together (`elevenlabs`, `elevenlabs:eleven_flash_v2_5`, …).
const toRows = (map: Record<string, number> | undefined): Rows =>
  Object.entries(map ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }));
const toMap = (rows: Rows) => Object.fromEntries(rows.filter((r) => r.key.trim() !== '' || r.value !== null).map((r) => [r.key.trim(), r.value]));

function CostsForm({ initial, meta }: { initial: RetellCostInputs | null; meta: { version: number | null; updated_by_email: string | null; updated_at: string | null } }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const denied = can.editCosts();
  const disabled = Boolean(denied);
  const save = useAdminSaveRetellCosts(api);
  const [engine, setEngine] = React.useState<number | null>(initial?.voice_engine_cents_per_min ?? null);
  const [kb, setKb] = React.useState<number | null>(initial?.knowledge_base_cents_per_min ?? null);
  const [floor, setFloor] = React.useState<number | null>(initial?.margin_floor_pct ?? 35);
  const [monthly, setMonthly] = React.useState<Record<keyof RetellCostInputs['monthly_cents'], number | null>>({
    phone_number: initial?.monthly_cents.phone_number ?? null,
    concurrency_slot: initial?.monthly_cents.concurrency_slot ?? null,
    knowledge_base: initial?.monthly_cents.knowledge_base ?? null,
  });
  const [maps, setMaps] = React.useState<Record<RateMap, Rows>>({
    tts_cents_per_min: toRows(initial?.tts_cents_per_min),
    llm_cents_per_min: toRows(initial?.llm_cents_per_min),
    telephony_cents_per_min: toRows(initial?.telephony_cents_per_min),
    analysis_cents_per_call: toRows(initial?.analysis_cents_per_call),
  });
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  async function submit() {
    const duplicate = MAPS.find((m) => new Set(maps[m.name].map((r) => r.key.trim())).size !== maps[m.name].length);
    if (duplicate) {
      setErrors({ [duplicate.name]: 'Each key can appear once.' });
      return;
    }
    const parsed = retellCostInputs.safeParse({
      voice_engine_cents_per_min: engine,
      knowledge_base_cents_per_min: kb,
      margin_floor_pct: floor,
      monthly_cents: monthly,
      tts_cents_per_min: toMap(maps.tts_cents_per_min),
      llm_cents_per_min: toMap(maps.llm_cents_per_min),
      telephony_cents_per_min: toMap(maps.telephony_cents_per_min),
      analysis_cents_per_call: toMap(maps.analysis_cents_per_call),
    });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) {
        // A map's issues name the row's key; report them on the map's table.
        const path = MAPS.some((m) => m.name === i.path[0]) ? String(i.path[0]) : i.path.join('.');
        errs[path] ??= i.path.length > 1 && MAPS.some((m) => m.name === i.path[0]) ? `${String(i.path[1]) || 'A row with no key'}: ${i.message}` : i.message;
      }
      setErrors(errs);
      return;
    }
    setErrors({});
    try {
      await save.mutateAsync({ body: parsed.data });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['adminRetellCosts'] }), queryClient.invalidateQueries({ queryKey: ['adminPricingPreview'] })]);
      toast.success('Cost inputs saved');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="text-sm">Voice platform cost inputs</CardTitle>
        <CardDescription>
          {meta.version ? `Version ${meta.version} · ${meta.updated_by_email ?? 'seeded'} · ${formatDateTime(meta.updated_at)}` : 'Not set yet. Until these are saved, publishing pricing needs a super admin override.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {!initial ? <Alert variant="warning">There are no cost inputs in the itemised form, so every margin reads as unknown. Fill in the platform&apos;s price list and save.</Alert> : null}
        <p className="text-sm text-muted-foreground">
          US cents, from the platform&apos;s pricing page or, where they differ, its bill. A tier&apos;s minute is the voice engine, its default voice, its model, the dearest telephony country and the knowledge base.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field id="cost-engine" label="Voice engine (¢ / min)" error={errors.voice_engine_cents_per_min}>
            <NumField id="cost-engine" nullable value={engine} onChange={setEngine} disabled={disabled} />
          </Field>
          <Field id="cost-kb" label="Knowledge base (¢ / min)" error={errors.knowledge_base_cents_per_min}>
            <NumField id="cost-kb" nullable value={kb} onChange={setKb} disabled={disabled} />
          </Field>
          <Field id="cost-floor" label="Margin floor (%)" error={errors.margin_floor_pct} description="Publish is blocked below this unless a super admin overrides.">
            <NumField id="cost-floor" nullable value={floor} onChange={setFloor} disabled={disabled} />
          </Field>
        </div>

        {MAPS.map((m) => (
          <RateTable
            key={m.name}
            {...m}
            rows={maps[m.name]}
            error={errors[m.name]}
            disabled={disabled}
            onChange={(rows) => setMaps((prev) => ({ ...prev, [m.name]: rows }))}
          />
        ))}

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-medium">Monthly (¢ / month, for COGS)</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id="cost-month-number" label="Per bought number" error={errors['monthly_cents.phone_number']}>
              <NumField id="cost-month-number" nullable value={monthly.phone_number} onChange={(v) => setMonthly((p) => ({ ...p, phone_number: v }))} disabled={disabled} />
            </Field>
            <Field id="cost-month-slot" label="Per extra concurrency slot" error={errors['monthly_cents.concurrency_slot']}>
              <NumField id="cost-month-slot" nullable value={monthly.concurrency_slot} onChange={(v) => setMonthly((p) => ({ ...p, concurrency_slot: v }))} disabled={disabled} />
            </Field>
            <Field id="cost-month-kb" label="Per extra knowledge base" error={errors['monthly_cents.knowledge_base']}>
              <NumField id="cost-month-kb" nullable value={monthly.knowledge_base} onChange={(v) => setMonthly((p) => ({ ...p, knowledge_base: v }))} disabled={disabled} />
            </Field>
          </div>
        </fieldset>

        <div>
          <PermissionButton denied={denied} onClick={() => void submit()} loading={save.isPending}>
            Save cost inputs
          </PermissionButton>
        </div>
      </CardContent>
    </Card>
  );
}

function RateTable({ name, title, keyLabel, keyHint, unit, rows, error, disabled, onChange }: { name: RateMap; title: string; keyLabel: string; keyHint: string; unit: string; rows: Rows; error?: string; disabled: boolean; onChange: (rows: Rows) => void }) {
  const set = (i: number, patch: Partial<Rows[number]>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={error ? `${name}-error` : undefined}>
      <legend className="mb-1 text-sm font-medium">
        {title} <span className="font-normal text-muted-foreground">({unit})</span>
      </legend>
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">No rates yet. A tier whose {keyLabel.toLowerCase()} is not listed shows its margin as missing.</p> : null}
      {rows.map((row, i) => (
        // Below `sm` the key takes the whole line: `elevenlabs:eleven_multilingual_v2` truncated
        // to the width of a phone column reads the same as its three siblings.
        <div key={i} className="grid grid-cols-[1fr_auto] items-center gap-2 sm:grid-cols-[1fr_7rem_auto]">
          <Input aria-label={`${title}: ${keyLabel}, row ${i + 1}`} placeholder={keyHint} value={row.key} onChange={(e) => set(i, { key: e.target.value })} disabled={disabled} className="col-span-2 font-mono sm:col-span-1" />
          <NumField aria-label={`${title}: ${unit}, row ${i + 1}`} nullable value={row.value} onChange={(v) => set(i, { value: v })} disabled={disabled} />
          <Button variant="ghost" size="icon-sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} disabled={disabled} aria-label={`Remove ${row.key || `row ${i + 1}`} from ${title}`}>
            <Trash2 />
          </Button>
        </div>
      ))}
      {error ? (
        <p id={`${name}-error`} className="text-sm text-danger" aria-live="polite">
          {error}
        </p>
      ) : null}
      <div>
        <Button variant="outline" size="sm" onClick={() => onChange([...rows, { key: '', value: null }])} disabled={disabled}>
          <Plus /> Add {keyLabel.toLowerCase()}
        </Button>
      </div>
    </fieldset>
  );
}
