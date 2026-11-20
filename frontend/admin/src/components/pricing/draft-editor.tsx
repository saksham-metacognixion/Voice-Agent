'use client';

import { useAdminDiscardPricingDraft, useAdminPricingDraft, useAdminSavePricingDraft, useApi } from '@portal/api-client';
import { pricingConfig, type PricingConfig, type PricingPack } from '@portal/schemas';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, Switch, Textarea, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import * as React from 'react';
import { PermissionButton } from '@/src/components/common/permission-button';
import { LoadError } from '@/src/components/common/query-states';
import { StaffActionDialog } from '@/src/components/common/staff-action-dialog';
import { errorMessage } from '@/src/lib/errors';
import { formatDateTime } from '@/src/lib/format';
import { prettyJson } from '@/src/lib/json';
import { useStaff } from '@/src/staff/staff-provider';
import { NumField } from './num-field';
import { PackEditor } from './pack-editor';

/** SA5 Draft: a structured editor over `pricingConfig`, validated with zod before save; a raw JSON view for power users. */
export function DraftEditor() {
  const api = useApi();
  const draft = useAdminPricingDraft(api);
  if (draft.isPending) return <Skeleton className="h-96" aria-busy />;
  if (draft.isError) return <LoadError error={draft.error} onRetry={() => void draft.refetch()} />;
  return <Editor key={`${draft.data.id ?? 'none'}-${draft.data.updated_at ?? ''}`} initial={draft.data.config} meta={draft.data} />;
}

type Meta = { id: string | null; based_on_version: number | null; current_version: number; edited_by_email: string | null; updated_at: string | null };

function Editor({ initial, meta }: { initial: PricingConfig; meta: Meta }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { can } = useStaff();
  const denied = can.editPricingDraft();
  const save = useAdminSavePricingDraft(api);
  const discard = useAdminDiscardPricingDraft(api);
  const [config, setConfig] = React.useState<PricingConfig>(initial);
  const [raw, setRaw] = React.useState(false);
  const [rawText, setRawText] = React.useState(() => prettyJson(initial));
  const [rawError, setRawError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [discarding, setDiscarding] = React.useState(false);
  const dirty = JSON.stringify(config) !== JSON.stringify(initial);

  React.useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  function toggleRaw(next: boolean) {
    if (next) {
      setRawText(prettyJson(config));
      setRawError(null);
    } else {
      try {
        const parsed = pricingConfig.safeParse(JSON.parse(rawText));
        if (!parsed.success) {
          setRawError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
          return;
        }
        setConfig(parsed.data);
      } catch (e) {
        setRawError(e instanceof Error ? e.message : 'Invalid JSON');
        return;
      }
    }
    setRaw(next);
  }

  function validate(): PricingConfig | null {
    let candidate: unknown = config;
    if (raw) {
      try {
        candidate = JSON.parse(rawText);
      } catch (e) {
        setRawError(e instanceof Error ? e.message : 'Invalid JSON');
        return null;
      }
    }
    const parsed = pricingConfig.safeParse(candidate);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) errs[issue.path.join('.')] = issue.message;
      setErrors(errs);
      setRawError(raw ? Object.entries(errs).map(([k, v]) => `${k}: ${v}`).join('; ') : null);
      toast.error('The draft has validation errors');
      return null;
    }
    setErrors({});
    setRawError(null);
    return parsed.data;
  }

  async function onSave() {
    const valid = validate();
    if (!valid) return;
    try {
      await save.mutateAsync({ body: { config: valid } });
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['adminPricingDraft'] }), queryClient.invalidateQueries({ queryKey: ['adminPricingPreview'] })]);
      toast.success('Draft saved');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const packErrors = (i: number) =>
    Object.fromEntries(
      Object.entries(errors)
        .filter(([k]) => k.startsWith(`packs.${i}.`))
        .map(([k, v]) => [k.slice(`packs.${i}.`.length), v]),
    );
  const set = <K extends keyof PricingConfig>(key: K, value: PricingConfig[K]) => setConfig((c) => ({ ...c, [key]: value }));
  const setRates = <K extends keyof PricingConfig['rates']>(key: K, value: PricingConfig['rates'][K]) => set('rates', { ...config.rates, [key]: value });
  const setRecurring = <K extends keyof PricingConfig['recurring']>(key: K, value: PricingConfig['recurring'][K]) => set('recurring', { ...config.recurring, [key]: value });
  const setWallet = <K extends keyof PricingConfig['wallet_policy']>(key: K, value: PricingConfig['wallet_policy'][K]) => set('wallet_policy', { ...config.wallet_policy, [key]: value });
  const setTrial = <K extends keyof PricingConfig['trial']>(key: K, value: PricingConfig['trial'][K]) => set('trial', { ...config.trial, [key]: value });

  function addPack() {
    const blank: PricingPack = { id: '', name: '', price_cents: 0, currency: config.currency_default, credits: 0, bonus_credits: 0, plan_tier: 'starter', concurrency_cap: 2, kb_allowance: 0, max_agents: 1, max_numbers: 1, feature_gates: [], badge: null, description: null, sort_order: config.packs.length, visibility: 'public', regions: [], active: true };
    set('packs', [...config.packs, blank]);
  }

  const readOnly = Boolean(denied);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card p-3 text-sm">
        {meta.id ? (
          <span>
            Draft based on <Badge variant="outline">v{meta.based_on_version ?? '?'}</Badge> · edited by {meta.edited_by_email ?? '–'} {meta.updated_at ? formatDateTime(meta.updated_at) : ''}
          </span>
        ) : (
          <span>
            No draft yet — editing starts from the current version <Badge variant="outline">v{meta.current_version}</Badge>.
          </span>
        )}
        {dirty ? <Badge variant="warning">Unsaved changes</Badge> : null}
        <span className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Raw JSON <Switch checked={raw} onCheckedChange={toggleRaw} aria-label="Raw JSON" />
          </label>
          {meta.id ? (
            <PermissionButton variant="outline" size="sm" denied={denied} onClick={() => setDiscarding(true)}>
              Discard draft
            </PermissionButton>
          ) : null}
          <PermissionButton size="sm" denied={denied} onClick={() => void onSave()} loading={save.isPending}>
            Save draft
          </PermissionButton>
        </span>
      </div>
      {denied ? <Alert variant="neutral">{denied} You can read the draft but not change it.</Alert> : null}
      {rawError ? <Alert variant="danger">{rawError}</Alert> : null}

      {raw ? (
        <Textarea value={rawText} onChange={(e) => setRawText(e.target.value)} className="min-h-[60vh] font-mono text-xs" spellCheck={false} disabled={readOnly} aria-label="Pricing config JSON" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Currency</CardTitle>
            </CardHeader>
            <CardContent>
              <Field id="currency-default" label="Default currency" error={errors.currency_default} className="max-w-48">
                <Select value={config.currency_default} onValueChange={(v) => set('currency_default', v as PricingConfig['currency_default'])} disabled={readOnly}>
                  <SelectTrigger id="currency-default">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="CAD">CAD</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </CardContent>
          </Card>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Packs</h2>
              <Button variant="outline" size="sm" onClick={addPack} disabled={readOnly}>
                <Plus /> Add pack
              </Button>
            </div>
            {errors.packs ? <Alert variant="danger">{errors.packs}</Alert> : null}
            {config.packs.map((p, i) => (
              <PackEditor key={i} pack={p} index={i} errors={packErrors(i)} disabled={readOnly} onChange={(next) => set('packs', config.packs.map((x, j) => (j === i ? next : x)))} onRemove={() => set('packs', config.packs.filter((_, j) => j !== i))} />
            ))}
          </section>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Rates (credits per minute)</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field id="r-std" label="Standard" error={errors['rates.standard_per_min']}>
                <NumField id="r-std" value={config.rates.standard_per_min} onChange={(v) => setRates('standard_per_min', v ?? 0)} disabled={readOnly} />
              </Field>
              <Field id="r-prem" label="Premium" error={errors['rates.premium_per_min']}>
                <NumField id="r-prem" value={config.rates.premium_per_min} onChange={(v) => setRates('premium_per_min', v ?? 0)} disabled={readOnly} />
              </Field>
              <Field id="r-web" label="Web call" optional description="Empty = the agent's tier rate." error={errors['rates.web_call_per_min']}>
                <NumField id="r-web" nullable value={config.rates.web_call_per_min} onChange={(v) => setRates('web_call_per_min', v)} disabled={readOnly} />
              </Field>
              <Field id="r-tf" label="Toll-free surcharge" error={errors['rates.toll_free_surcharge_per_min']}>
                <NumField id="r-tf" value={config.rates.toll_free_surcharge_per_min} onChange={(v) => setRates('toll_free_surcharge_per_min', v ?? 0)} disabled={readOnly} />
              </Field>
              <Field id="r-tr" label="Transferred leg" error={errors['rates.transferred_leg_per_min']}>
                <NumField id="r-tr" value={config.rates.transferred_leg_per_min} onChange={(v) => setRates('transferred_leg_per_min', v ?? 0)} disabled={readOnly} />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Recurring charges</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field id="rc-rent" label="Number rental (credits / month)" error={errors['recurring.number_rental_credits']}>
                <NumField id="rc-rent" value={config.recurring.number_rental_credits} onChange={(v) => setRecurring('number_rental_credits', v ?? 0)} disabled={readOnly} />
              </Field>
              <Field id="rc-kb" label="Extra KB (credits / month)" error={errors['recurring.extra_kb_credits']}>
                <NumField id="rc-kb" value={config.recurring.extra_kb_credits} onChange={(v) => setRecurring('extra_kb_credits', v ?? 0)} disabled={readOnly} />
              </Field>
              <Field id="rc-rel" label="Release after days at zero" error={errors['recurring.release_after_days_at_zero_balance']}>
                <NumField id="rc-rel" integer value={config.recurring.release_after_days_at_zero_balance} onChange={(v) => setRecurring('release_after_days_at_zero_balance', v ?? 1)} disabled={readOnly} />
              </Field>
              <Field id="rc-warn" label="Rental warning days" description="Comma-separated days before due." error={errors['recurring.rental_warning_days']}>
                <Input id="rc-warn" value={config.recurring.rental_warning_days.join(', ')} onChange={(e) => setRecurring('rental_warning_days', e.target.value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))} disabled={readOnly} />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Wallet policy</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field id="w-trial" label="Trial credits" error={errors['wallet_policy.trial_credits']}>
                <NumField id="w-trial" value={config.wallet_policy.trial_credits} onChange={(v) => setWallet('trial_credits', v ?? 0)} disabled={readOnly} />
              </Field>
              <Field id="w-trialdays" label="Trial validity (days)" error={errors['wallet_policy.trial_validity_days']}>
                <NumField id="w-trialdays" integer value={config.wallet_policy.trial_validity_days} onChange={(v) => setWallet('trial_validity_days', v ?? 1)} disabled={readOnly} />
              </Field>
              <Field id="w-exp" label="Credit expiry (months)" error={errors['wallet_policy.credit_expiry_months']}>
                <NumField id="w-exp" integer value={config.wallet_policy.credit_expiry_months} onChange={(v) => setWallet('credit_expiry_months', v ?? 1)} disabled={readOnly} />
              </Field>
              <Field id="w-grace" label="Grace overdraft (credits)" error={errors['wallet_policy.grace_overdraft_credits']}>
                <NumField id="w-grace" value={config.wallet_policy.grace_overdraft_credits} onChange={(v) => setWallet('grace_overdraft_credits', v ?? 0)} disabled={readOnly} />
              </Field>
              <Field id="w-low" label="Low-balance thresholds (%)" description="Descending, comma-separated; 0 = hit zero." error={errors['wallet_policy.low_balance_thresholds_pct']}>
                <Input id="w-low" value={config.wallet_policy.low_balance_thresholds_pct.join(', ')} onChange={(e) => setWallet('low_balance_thresholds_pct', e.target.value.split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)))} disabled={readOnly} />
              </Field>
              <Field id="w-atd" label="Auto top-up default on" error={errors['wallet_policy.auto_topup_default_on']}>
                <div className="flex h-10 items-center">
                  <Switch id="w-atd" checked={config.wallet_policy.auto_topup_default_on} onCheckedChange={(v) => setWallet('auto_topup_default_on', v)} disabled={readOnly} />
                </div>
              </Field>
              <Field id="w-att" label="Auto top-up threshold (%)" error={errors['wallet_policy.auto_topup_threshold_pct']}>
                <NumField id="w-att" value={config.wallet_policy.auto_topup_threshold_pct} onChange={(v) => setWallet('auto_topup_threshold_pct', v ?? 0)} disabled={readOnly} />
              </Field>
              <Field id="w-first" label="Max first purchase w/o review (cents)" error={errors['wallet_policy.max_first_purchase_cents_without_review']}>
                <NumField id="w-first" integer value={config.wallet_policy.max_first_purchase_cents_without_review} onChange={(v) => setWallet('max_first_purchase_cents_without_review', v ?? 1)} disabled={readOnly} />
              </Field>
              <Field id="w-mfa" label="MFA required above balance" error={errors['wallet_policy.mfa_required_above_balance']}>
                <NumField id="w-mfa" value={config.wallet_policy.mfa_required_above_balance} onChange={(v) => setWallet('mfa_required_above_balance', v ?? 0)} disabled={readOnly} />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Trial caps</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field id="t-cc" label="Concurrency cap" error={errors['trial.concurrency_cap']}>
                <NumField id="t-cc" integer value={config.trial.concurrency_cap} onChange={(v) => setTrial('concurrency_cap', v ?? 0)} disabled={readOnly} />
              </Field>
              <Field id="t-kb" label="KB allowance" error={errors['trial.kb_allowance']}>
                <NumField id="t-kb" integer value={config.trial.kb_allowance} onChange={(v) => setTrial('kb_allowance', v ?? 0)} disabled={readOnly} />
              </Field>
              <Field id="t-ag" label="Max agents" error={errors['trial.max_agents']}>
                <NumField id="t-ag" integer value={config.trial.max_agents} onChange={(v) => setTrial('max_agents', v ?? 0)} disabled={readOnly} />
              </Field>
              <Field id="t-nu" label="Max numbers" error={errors['trial.max_numbers']}>
                <NumField id="t-nu" integer value={config.trial.max_numbers} onChange={(v) => setTrial('max_numbers', v ?? 0)} disabled={readOnly} />
              </Field>
              <Field id="t-gates" label="Feature gates" description="Comma-separated gate ids." error={errors['trial.feature_gates']} className="sm:col-span-2">
                <Input id="t-gates" value={config.trial.feature_gates.join(', ')} onChange={(e) => setTrial('feature_gates', e.target.value.split(',').map((s) => s.trim()).filter(Boolean) as PricingConfig['trial']['feature_gates'])} disabled={readOnly} />
              </Field>
            </CardContent>
          </Card>
        </>
      )}

      <StaffActionDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title="Discard the pricing draft"
        consequences={['Every unpublished change is lost.', 'The current version stays in effect; nothing the customer sees changes.']}
        confirmLabel="Discard draft"
        destructive
        onConfirm={async (body) => {
          await discard.mutateAsync({ body });
          await Promise.all([queryClient.invalidateQueries({ queryKey: ['adminPricingDraft'] }), queryClient.invalidateQueries({ queryKey: ['adminPricingPreview'] })]);
          toast.success('Draft discarded');
        }}
      />
    </div>
  );
}
