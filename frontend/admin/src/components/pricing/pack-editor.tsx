'use client';

import { featureGate, packVisibility, planTier, type PricingPack } from '@portal/schemas';
import { Button, Checkbox, Field, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea, cn } from '@portal/ui';
import { Trash2 } from 'lucide-react';
import { NumField } from './num-field';
import { humanize } from '@/src/lib/format';

/** One §5.2 pack as a form card (SA5 Packs table). `errors` are keyed by the field name. */
export function PackEditor({ pack, index, errors, disabled, onChange, onRemove }: { pack: PricingPack; index: number; errors: Record<string, string>; disabled?: boolean; onChange: (next: PricingPack) => void; onRemove: () => void }) {
  const set = <K extends keyof PricingPack>(key: K, value: PricingPack[K]) => onChange({ ...pack, [key]: value });
  const id = (f: string) => `pack-${index}-${f}`;
  return (
    <div className={cn('flex flex-col gap-4 rounded-lg border border-border bg-card p-4', !pack.active && 'opacity-70')}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{pack.id || '(new pack)'}</span>
          {!pack.active ? <span className="text-xs text-muted-foreground">inactive</span> : null}
        </div>
        <div className="flex items-center gap-3">
          <Label htmlFor={id('active')} className="text-xs text-muted-foreground">
            Active
          </Label>
          <Switch id={id('active')} checked={pack.active} onCheckedChange={(v) => set('active', v)} disabled={disabled} />
          <Button variant="ghost" size="icon-sm" onClick={onRemove} disabled={disabled} aria-label={`Remove pack ${pack.id}`}>
            <Trash2 />
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id={id('id')} label="Id (slug)" error={errors.id}>
          <Input id={id('id')} value={pack.id} onChange={(e) => set('id', e.target.value)} disabled={disabled} className="font-mono" />
        </Field>
        <Field id={id('name')} label="Name" error={errors.name}>
          <Input id={id('name')} value={pack.name} onChange={(e) => set('name', e.target.value)} disabled={disabled} />
        </Field>
        <Field id={id('price')} label="Price (cents)" error={errors.price_cents}>
          <NumField id={id('price')} integer value={pack.price_cents} onChange={(v) => set('price_cents', v ?? 0)} disabled={disabled} />
        </Field>
        <Field id={id('currency')} label="Currency" error={errors.currency}>
          <Select value={pack.currency} onValueChange={(v) => set('currency', v as PricingPack['currency'])} disabled={disabled}>
            <SelectTrigger id={id('currency')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="USD">USD</SelectItem>
              <SelectItem value="CAD">CAD</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id={id('credits')} label="Credits" error={errors.credits}>
          <NumField id={id('credits')} integer value={pack.credits} onChange={(v) => set('credits', v ?? 0)} disabled={disabled} />
        </Field>
        <Field id={id('bonus')} label="Bonus credits" error={errors.bonus_credits}>
          <NumField id={id('bonus')} integer value={pack.bonus_credits} onChange={(v) => set('bonus_credits', v ?? 0)} disabled={disabled} />
        </Field>
        <Field id={id('tier')} label="Plan tier" error={errors.plan_tier}>
          <Select value={pack.plan_tier} onValueChange={(v) => set('plan_tier', v as PricingPack['plan_tier'])} disabled={disabled}>
            <SelectTrigger id={id('tier')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {planTier.options.map((t) => (
                <SelectItem key={t} value={t}>
                  {humanize(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id={id('sort')} label="Sort order" error={errors.sort_order}>
          <NumField id={id('sort')} integer value={pack.sort_order} onChange={(v) => set('sort_order', v ?? 0)} disabled={disabled} />
        </Field>
        <Field id={id('cc')} label="Concurrency cap" error={errors.concurrency_cap}>
          <NumField id={id('cc')} integer value={pack.concurrency_cap} onChange={(v) => set('concurrency_cap', v ?? 0)} disabled={disabled} />
        </Field>
        <Field id={id('kb')} label="KB allowance" error={errors.kb_allowance}>
          <NumField id={id('kb')} integer value={pack.kb_allowance} onChange={(v) => set('kb_allowance', v ?? 0)} disabled={disabled} />
        </Field>
        <Field id={id('agents')} label="Max agents" error={errors.max_agents}>
          <NumField id={id('agents')} integer value={pack.max_agents} onChange={(v) => set('max_agents', v ?? 0)} disabled={disabled} />
        </Field>
        <Field id={id('numbers')} label="Max numbers" error={errors.max_numbers}>
          <NumField id={id('numbers')} integer value={pack.max_numbers} onChange={(v) => set('max_numbers', v ?? 0)} disabled={disabled} />
        </Field>
        <Field id={id('badge')} label="Badge" optional error={errors.badge}>
          <Input id={id('badge')} value={pack.badge ?? ''} onChange={(e) => set('badge', e.target.value || null)} disabled={disabled} placeholder="Most popular" />
        </Field>
        <Field id={id('visibility')} label="Visibility" error={errors.visibility}>
          <Select value={pack.visibility} onValueChange={(v) => set('visibility', v as PricingPack['visibility'])} disabled={disabled}>
            <SelectTrigger id={id('visibility')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {packVisibility.options.map((v) => (
                <SelectItem key={v} value={v}>
                  {humanize(v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id={id('regions')} label="Regions" optional description="ISO codes, comma-separated. Empty = everywhere." error={errors.regions} className="lg:col-span-2">
          <Input id={id('regions')} value={pack.regions.join(', ')} onChange={(e) => set('regions', e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))} disabled={disabled} placeholder="US, CA" />
        </Field>
        <Field id={id('desc')} label="Description" optional error={errors.description} className="sm:col-span-2 lg:col-span-4">
          <Textarea id={id('desc')} value={pack.description ?? ''} onChange={(e) => set('description', e.target.value || null)} disabled={disabled} rows={2} className="min-h-16" />
        </Field>
      </div>
      <Field label="Feature gates" error={errors.feature_gates}>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {featureGate.options.map((g) => {
            const checked = pack.feature_gates.includes(g);
            return (
              <label key={g} className="flex items-center gap-2 text-sm">
                <Checkbox checked={checked} disabled={disabled} onCheckedChange={(v) => set('feature_gates', v ? [...pack.feature_gates, g] : pack.feature_gates.filter((x) => x !== g))} />
                {humanize(g)}
              </label>
            );
          })}
        </div>
      </Field>
    </div>
  );
}
