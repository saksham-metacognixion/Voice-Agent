'use client';

import { useApi, useUpdateAgentDraft } from '@portal/api-client';
import { isPhoneFieldName, type AgentDetail, type AnalysisField } from '@portal/schemas';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { track } from '@/src/analytics/posthog';
import { ANALYSIS_FIELD_TYPES as TYPES, MAX_ANALYSIS_FIELDS as MAX_FIELDS, duplicateNameAt, isFieldName, rowToField, toRow, type AnalysisFieldType as FieldType, type AnalysisFieldRow as Row } from '@/src/dashboard/analysis-fields';
import { usePlanGate } from '@/src/dashboard/use-plan-gate';
import { errorMessage } from '@/src/lib/errors';

/**
 * D3 Brief "Analysis fields" (spec p. 36, §9.8, QA-079): what the agent writes down after
 * every call — the template's fields, the ones generation added, and the customer's own.
 * Plan gate `analysis_fields`; without it the list is shown read-only with the pack that
 * unlocks it. Saved as one list through `PATCH /agents/:id/draft {analysis_fields}`, into
 * the draft like every other edit, and live at the next publish. Once edited, the list
 * is the customer's: a regenerate keeps it as it is (`analysis_fields_edited`).
 */
export function AnalysisFieldsEditor({ agent, fields, canEdit }: { agent: AgentDetail; fields: AnalysisField[]; canEdit: boolean }) {
  const t = useTranslations('dashboard.agents.brief.fields');
  const tg = useTranslations('dashboard.planGate');
  const tc = useTranslations();
  const api = useApi();
  const queryClient = useQueryClient();
  const patch = useUpdateAgentDraft(api);
  const gate = usePlanGate('analysis_fields');
  const nextKey = React.useRef(fields.length);
  const [rows, setRows] = React.useState<Row[]>(() => fields.map(toRow));
  const [error, setError] = React.useState<string | null>(null);

  const editable = canEdit && !gate.locked;
  const parsed = rows.map(rowToField);
  const duplicate = (i: number) => duplicateNameAt(rows, i);
  const valid = parsed.every(Boolean) && !rows.some((_, i) => duplicate(i));
  const dirty = JSON.stringify(parsed) !== JSON.stringify(fields);

  function update(key: number, change: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  async function save() {
    if (!valid) return;
    setError(null);
    try {
      await patch.mutateAsync({ params: { id: agent.id }, body: { analysis_fields: parsed as AnalysisField[] } });
      await queryClient.invalidateQueries({ queryKey: ['getAgent', { id: agent.id }] });
      toast.success(t('saved'));
      track('agent_analysis_fields_saved', { agent_id: agent.id, fields: parsed.length });
    } catch (e) {
      setError(errorMessage(e, tc));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {gate.locked ? <Alert variant="info">{gate.packName ? tg('lockedPack', { pack: gate.packName }) : tg('lockedGeneric')}</Alert> : null}
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('empty')}</p> : null}
        <ul className="flex flex-col gap-4">
          {rows.map((row, i) => {
            const nameInvalid = row.name.trim() !== '' && (!isFieldName(row.name) || duplicate(i));
            return (
              <li key={row.key} className="flex flex-col gap-2 rounded-md border border-border p-3">
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto]">
                  <Input
                    value={row.name}
                    maxLength={40}
                    dir="ltr"
                    disabled={!editable}
                    aria-label={t('name')}
                    aria-invalid={nameInvalid || undefined}
                    placeholder={t('namePlaceholder')}
                    onChange={(e) => update(row.key, { name: e.target.value.toLowerCase().replace(/[\s-]+/g, '_') })}
                  />
                  <Select value={row.type} onValueChange={(v) => update(row.key, { type: v as FieldType })} disabled={!editable}>
                    <SelectTrigger aria-label={t('type')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {t(`types.${type}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {editable ? (
                    <Button variant="ghost" size="icon" aria-label={t('remove', { name: row.name || '…' })} onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}>
                      <Trash2 aria-hidden />
                    </Button>
                  ) : null}
                </div>
                <Input value={row.description} maxLength={300} dir="auto" disabled={!editable} aria-label={t('description')} placeholder={t('descriptionPlaceholder')} onChange={(e) => update(row.key, { description: e.target.value })} />
                {row.type === 'enum' ? (
                  <Input value={row.choices} dir="auto" disabled={!editable} aria-label={t('choices')} placeholder={t('choicesPlaceholder')} onChange={(e) => update(row.key, { choices: e.target.value })} />
                ) : null}
                {nameInvalid ? <p className="text-xs text-danger">{duplicate(i) ? t('duplicate') : t('nameRule')}</p> : null}
                {row.type === 'text' && isPhoneFieldName(row.name) ? <p className="text-xs text-muted-foreground">{t('phoneHint')}</p> : null}
              </li>
            );
          })}
        </ul>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        {editable ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              variant="outline"
              disabled={rows.length >= MAX_FIELDS}
              onClick={() => setRows((current) => [...current, { key: ++nextKey.current, name: '', type: 'text', description: '', choices: '' }])}
            >
              <Plus aria-hidden /> {t('add')}
            </Button>
            <Button onClick={() => void save()} disabled={!dirty || !valid} loading={patch.isPending}>
              {t('save')}
            </Button>
          </div>
        ) : null}
        {editable && rows.length >= MAX_FIELDS ? <p className="text-xs text-muted-foreground">{t('max', { n: MAX_FIELDS })}</p> : null}
      </CardContent>
    </Card>
  );
}
