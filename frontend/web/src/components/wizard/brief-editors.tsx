'use client';

import type { HandoffRule, Personality } from '@portal/schemas';
import { Button, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Slider, Textarea, cn } from '@portal/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

type FaqPair = { question: string; answer: string };

/** W2 #7 — FAQ pairs. */
export function FaqEditor({ value, onChange, disabled, errors }: { value: FaqPair[]; onChange: (v: FaqPair[]) => void; disabled?: boolean; errors?: Array<{ question?: string; answer?: string } | undefined> }) {
  const t = useTranslations('wizard.w2.fields.faqs');
  return (
    <div className="flex flex-col gap-3">
      {value.map((pair, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-card">
          <div className="flex items-start gap-2">
            <Field id={`faq-q-${i}`} label={t('question')} className="flex-1" error={errors?.[i]?.question}>
              <Input id={`faq-q-${i}`} value={pair.question} maxLength={300} disabled={disabled} placeholder={t('questionPlaceholder')} onChange={(e) => onChange(value.map((p, j) => (j === i ? { ...p, question: e.target.value } : p)))} />
            </Field>
            <Button type="button" variant="ghost" size="icon" className="mt-6 text-muted-foreground" disabled={disabled} aria-label={`${t('question')} ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 />
            </Button>
          </div>
          <Field id={`faq-a-${i}`} label={t('answer')} error={errors?.[i]?.answer}>
            <Textarea id={`faq-a-${i}`} value={pair.answer} maxLength={1000} rows={2} disabled={disabled} placeholder={t('answerPlaceholder')} className="min-h-16" onChange={(e) => onChange(value.map((p, j) => (j === i ? { ...p, answer: e.target.value } : p)))} />
          </Field>
        </div>
      ))}
      {value.length < 20 ? (
        <Button type="button" variant="outline" size="sm" className="w-fit" disabled={disabled} onClick={() => onChange([...value, { question: '', answer: '' }])}>
          <Plus /> {t('add')}
        </Button>
      ) : null}
    </div>
  );
}

/** W2 #9 — hand-off rules: when the caller …, then transfer / take a message / read a message. */
export function HandoffRulesEditor({ value, onChange, disabled, errors }: { value: HandoffRule[]; onChange: (v: HandoffRule[]) => void; disabled?: boolean; errors?: Array<{ condition?: string; transfer_number?: string } | undefined> }) {
  const t = useTranslations('wizard.w2.fields.handoff_rules');
  const update = (i: number, patch: Partial<HandoffRule>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-3">
      {value.map((rule, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-card">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-start">
            <Field id={`rule-c-${i}`} label={t('condition')} error={errors?.[i]?.condition}>
              <Input id={`rule-c-${i}`} value={rule.condition} maxLength={200} disabled={disabled} placeholder={t('conditionPlaceholder')} onChange={(e) => update(i, { condition: e.target.value })} />
            </Field>
            <Field id={`rule-a-${i}`} label={t('action')} className="sm:w-56">
              <Select value={rule.action} disabled={disabled} onValueChange={(action) => update(i, { action: action as HandoffRule['action'], ...(action === 'transfer' ? {} : { transfer_number: undefined }) })}>
                <SelectTrigger id={`rule-a-${i}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="transfer">{t('actions.transfer')}</SelectItem>
                  <SelectItem value="take_message">{t('actions.take_message')}</SelectItem>
                  <SelectItem value="read_message">{t('actions.read_message')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Button type="button" variant="ghost" size="icon" className="text-muted-foreground sm:mt-6" disabled={disabled} aria-label={`${t('condition')} ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 />
            </Button>
          </div>
          {rule.action === 'transfer' ? (
            <Field id={`rule-n-${i}`} label={t('number')} error={errors?.[i]?.transfer_number} className="sm:max-w-xs">
              <Input id={`rule-n-${i}`} type="tel" inputMode="tel" value={rule.transfer_number ?? ''} disabled={disabled} placeholder="+14155550123" invalid={Boolean(errors?.[i]?.transfer_number)} onChange={(e) => update(i, { transfer_number: e.target.value || undefined })} />
            </Field>
          ) : null}
        </div>
      ))}
      {value.length < 5 ? (
        <Button type="button" variant="outline" size="sm" className="w-fit" disabled={disabled} onClick={() => onChange([...value, { condition: '', action: 'take_message' }])}>
          <Plus /> {t('add')}
        </Button>
      ) : null}
    </div>
  );
}

/** W2 #11 — three sliders and a note. */
export function PersonalityEditor({ value, onChange, disabled }: { value: Personality; onChange: (v: Personality) => void; disabled?: boolean }) {
  const t = useTranslations('wizard.w2.fields.personality');
  const dims = ['formality', 'brevity', 'energy'] as const;
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-card">
      {dims.map((dim) => (
        <div key={dim} className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-foreground">{t(`${dim}.label`)}</span>
          </div>
          <Slider
            value={[Math.round((value[dim] ?? 0.5) * 100)]}
            min={0}
            max={100}
            step={5}
            disabled={disabled}
            aria-label={t(`${dim}.label`)}
            onValueChange={([v]) => onChange({ ...value, [dim]: (v ?? 50) / 100 })}
          />
          <div className={cn('flex justify-between text-[11px] text-muted-foreground')}>
            <span>{t(`${dim}.low`)}</span>
            <span>{t(`${dim}.high`)}</span>
          </div>
        </div>
      ))}
      <Field id="personality-notes" label={t('notes')}>
        <Input id="personality-notes" value={value.notes ?? ''} maxLength={300} disabled={disabled} placeholder={t('notesPlaceholder')} onChange={(e) => onChange({ ...value, notes: e.target.value || undefined })} />
      </Field>
    </div>
  );
}
