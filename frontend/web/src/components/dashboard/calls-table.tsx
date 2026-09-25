'use client';

import type { CallSort, CallSummary, SortOrder } from '@portal/schemas';
import { Checkbox, cn } from '@portal/ui';
import { ArrowDown, ArrowUp, ArrowUpDown, Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CallStatusBadge, SentimentBadge } from '@/src/components/dashboard/status-badges';
import { formatCreditsValue, formatDateTime, formatDuration, formatPhone } from '@/src/lib/format';

export interface CallsTableProps {
  calls: CallSummary[];
  agentName: (id: string | null) => string | undefined;
  timeZone: string | undefined;
  sort: CallSort;
  order: SortOrder;
  onSort: (sort: CallSort) => void;
  selected: Set<string>;
  onSelect: (id: string, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  canSelect: boolean;
  activeId: string | null;
  onOpen: (id: string) => void;
}

/**
 * D2 list (spec p. 34): when, who, agent, duration, mood, credits, status, handled. The
 * three sortable columns sort on the server (`?sort=&order=`); a click on a row opens the
 * drawer, a click on its checkbox selects it for the bulk bar.
 *
 * Below 640 px the rows become cards (§12.5) carrying every column the table does, and
 * the table is not rendered into the layout at all: Chrome sizes the mobile layout
 * viewport from a table's minimum width even inside a scrolling wrapper, so a 46-rem
 * table would widen every page it sits on. Sorting on a phone is the filter bar's.
 */
export function CallsTable({ calls, agentName, timeZone, sort, order, onSort, selected, onSelect, onSelectAll, canSelect, activeId, onOpen }: CallsTableProps) {
  const t = useTranslations('dashboard.calls.columns');
  const tl = useTranslations('dashboard.calls');
  const allSelected = calls.length > 0 && calls.every((c) => selected.has(c.id));
  const someSelected = calls.some((c) => selected.has(c.id));

  return (
    <>
      <ul className="flex flex-col gap-3 sm:hidden" aria-label={tl('title')}>
        {calls.map((call) => (
          <CallCard
            key={call.id}
            call={call}
            agentName={agentName(call.agent_id) ?? (call.agent_id ? '…' : '–')}
            timeZone={timeZone}
            selected={selected.has(call.id)}
            canSelect={canSelect}
            active={activeId === call.id}
            onSelect={(checked) => onSelect(call.id, checked)}
            onOpen={() => onOpen(call.id)}
          />
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-lg border border-border bg-card sm:block">
        <table className="w-full min-w-0 text-left text-sm sm:min-w-[46rem]">
          <thead className="bg-muted/60 text-xs text-muted-foreground">
            <tr>
              {canSelect ? (
                <th className="w-10 px-3 py-2.5">
                  <Checkbox checked={allSelected ? true : someSelected ? 'indeterminate' : false} onCheckedChange={(v) => onSelectAll(v === true)} aria-label={tl('selectAll')} />
                </th>
              ) : null}
              <SortHeader label={t('when')} column="started_at" sort={sort} order={order} onSort={onSort} />
              <th className="px-3 py-2.5 font-medium">{t('caller')}</th>
              <th className="hidden px-3 py-2.5 font-medium md:table-cell">{t('agent')}</th>
              <SortHeader label={t('duration')} column="duration_s" sort={sort} order={order} onSort={onSort} align="right" className="hidden sm:table-cell" />
              <th className="hidden px-3 py-2.5 font-medium sm:table-cell">{t('mood')}</th>
              <SortHeader label={t('credits')} column="credits_charged" sort={sort} order={order} onSort={onSort} align="right" className="hidden sm:table-cell" />
              <th className="px-3 py-2.5 font-medium">{t('status')}</th>
              <th className="hidden px-3 py-2.5 text-center font-medium sm:table-cell">{t('handled')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {calls.map((call) => {
              const isSelected = selected.has(call.id);
              return (
                <tr
                  key={call.id}
                  className={cn('cursor-pointer transition-colors hover:bg-muted/50', activeId === call.id && 'bg-accent/50', isSelected && 'bg-primary/5')}
                  onClick={() => onOpen(call.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpen(call.id);
                    }
                  }}
                  tabIndex={0}
                  aria-selected={activeId === call.id}
                >
                  {canSelect ? (
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <Checkbox checked={isSelected} onCheckedChange={(v) => onSelect(call.id, v === true)} aria-label={tl('selectOne')} />
                    </td>
                  ) : null}
                  <td className="whitespace-nowrap px-3 py-2.5 tabular-nums">{formatDateTime(call.started_at ?? call.created_at, timeZone)}</td>
                  <td className="px-3 py-2.5">
                    <span className="font-medium">{call.channel === 'web' ? tl('browserTest') : formatPhone(call.from_number) === '–' ? tl('unknownCaller') : formatPhone(call.from_number)}</span>
                    {call.is_test && call.channel !== 'web' ? <span className="ml-1 text-xs text-muted-foreground">({tl('test')})</span> : null}
                  </td>
                  <td className="hidden max-w-[10rem] truncate px-3 py-2.5 text-muted-foreground md:table-cell">{agentName(call.agent_id) ?? (call.agent_id ? '…' : '–')}</td>
                  <td className="hidden px-3 py-2.5 text-right tabular-nums sm:table-cell">{formatDuration(call.duration_s)}</td>
                  <td className="hidden px-3 py-2.5 sm:table-cell">
                    <SentimentBadge value={call.sentiment} compact />
                  </td>
                  <td className="hidden px-3 py-2.5 text-right tabular-nums sm:table-cell">{call.credits_charged !== null ? formatCreditsValue(call.credits_charged) : '–'}</td>
                  <td className="px-3 py-2.5">
                    <CallStatusBadge status={call.status} />
                  </td>
                  <td className="hidden px-3 py-2.5 text-center sm:table-cell">{call.handled_at ? <Check className="mx-auto size-4 text-success" aria-label={tl('handledYes')} /> : <span className="text-muted-foreground">–</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CallCard({ call, agentName, timeZone, selected, canSelect, active, onSelect, onOpen }: { call: CallSummary; agentName: string; timeZone: string | undefined; selected: boolean; canSelect: boolean; active: boolean; onSelect: (checked: boolean) => void; onOpen: () => void }) {
  const t = useTranslations('dashboard.calls.columns');
  const tl = useTranslations('dashboard.calls');
  const caller = call.channel === 'web' ? tl('browserTest') : formatPhone(call.from_number) === '–' ? tl('unknownCaller') : formatPhone(call.from_number);
  return (
    <li
      className={cn('flex cursor-pointer flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-card active:bg-muted/50', active && 'border-primary/50 bg-accent/50', selected && 'bg-primary/5')}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      aria-current={active || undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {canSelect ? (
            <span className="pt-0.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <Checkbox checked={selected} onCheckedChange={(v) => onSelect(v === true)} aria-label={tl('selectOne')} className="size-5" />
            </span>
          ) : null}
          <div className="flex min-w-0 flex-col">
            <span className="break-words font-semibold tabular-nums">
              {caller}
              {call.is_test && call.channel !== 'web' ? <span className="ml-1 text-xs font-normal text-muted-foreground">({tl('test')})</span> : null}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">{formatDateTime(call.started_at ?? call.created_at, timeZone)}</span>
          </div>
        </div>
        <CallStatusBadge status={call.status} />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{t('agent')}</dt>
          <dd className="truncate">{agentName}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{t('duration')}</dt>
          <dd className="tabular-nums">{formatDuration(call.duration_s)}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{t('mood')}</dt>
          <dd>
            <SentimentBadge value={call.sentiment} />
          </dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{t('credits')}</dt>
          <dd className="tabular-nums">{call.credits_charged !== null ? formatCreditsValue(call.credits_charged) : '–'}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-xs text-muted-foreground">{t('handled')}</dt>
          <dd>{call.handled_at ? <Check className="size-4 text-success" aria-label={tl('handledYes')} /> : <span className="text-muted-foreground">–</span>}</dd>
        </div>
      </dl>
    </li>
  );
}

function SortHeader({ label, column, sort, order, onSort, align, className }: { label: string; column: CallSort; sort: CallSort; order: SortOrder; onSort: (s: CallSort) => void; align?: 'right'; className?: string }) {
  const active = sort === column;
  const Icon = !active ? ArrowUpDown : order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={cn('px-3 py-2.5 font-medium', align === 'right' && 'text-right', className)} aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={cn('inline-flex items-center gap-1 hover:text-foreground', active && 'text-foreground')} onClick={() => onSort(column)}>
        {label}
        <Icon className="size-3.5" aria-hidden />
      </button>
    </th>
  );
}
