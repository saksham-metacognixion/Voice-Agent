'use client';

import type { AgentSummary } from '@portal/schemas';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@portal/ui';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CALL_STATUSES, RANGE_PRESETS, hasFilters, type CallsView } from '@/src/dashboard/calls-url';

const ANY = '__any__';

/**
 * D2 filters (spec p. 34), one row above the table. Every control writes to the URL
 * through `onChange`; nothing here holds filter state of its own.
 */
export function CallsFilters({ view, agents, onChange }: { view: CallsView; agents: AgentSummary[]; onChange: (patch: Partial<CallsView>) => void }) {
  const t = useTranslations('dashboard.calls.filters');
  const ts = useTranslations('dashboard.calls.status');
  const tri = (value: boolean | null) => (value === null ? ANY : String(value));
  const fromTri = (v: string): boolean | null => (v === ANY ? null : v === 'true');

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label={t('range')} className="inline-flex w-fit rounded-md border border-border bg-muted p-0.5 text-xs">
        {RANGE_PRESETS.map((r) => (
          <button
            key={r}
            type="button"
            role="tab"
            aria-selected={view.range === r}
            onClick={() => onChange({ range: r })}
            className={cn('rounded px-2.5 py-1 font-medium transition-colors', view.range === r ? 'bg-card text-foreground shadow-card' : 'text-muted-foreground hover:text-foreground')}
          >
            {t(`ranges.${r}`)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={view.status ?? ANY} onValueChange={(v) => onChange({ status: v === ANY ? null : (v as CallsView['status']) })}>
          <SelectTrigger className="h-9 w-[9.5rem]" aria-label={t('status')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t('anyStatus')}</SelectItem>
            {CALL_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {ts(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={view.agentId ?? ANY} onValueChange={(v) => onChange({ agentId: v === ANY ? null : v })}>
          <SelectTrigger className="h-9 w-[11rem]" aria-label={t('agent')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t('anyAgent')}</SelectItem>
            {agents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={view.channel ?? ANY} onValueChange={(v) => onChange({ channel: v === ANY ? null : (v as CallsView['channel']) })}>
          <SelectTrigger className="h-9 w-[8.5rem]" aria-label={t('channel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t('anyChannel')}</SelectItem>
            <SelectItem value="phone">{t('phone')}</SelectItem>
            <SelectItem value="web">{t('web')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={tri(view.test)} onValueChange={(v) => onChange({ test: fromTri(v) })}>
          <SelectTrigger className="h-9 w-[9.5rem]" aria-label={t('test')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t('testAny')}</SelectItem>
            <SelectItem value="false">{t('testHide')}</SelectItem>
            <SelectItem value="true">{t('testOnly')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={tri(view.handled)} onValueChange={(v) => onChange({ handled: fromTri(v) })}>
          <SelectTrigger className="h-9 w-[9.5rem]" aria-label={t('handled')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t('handledAny')}</SelectItem>
            <SelectItem value="false">{t('handledNo')}</SelectItem>
            <SelectItem value="true">{t('handledYes')}</SelectItem>
          </SelectContent>
        </Select>
        {hasFilters(view) ? (
          <Button variant="ghost" size="sm" onClick={() => onChange({ status: null, agentId: null, channel: null, test: null, handled: null, range: 'all' })}>
            <X /> {t('clear')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
