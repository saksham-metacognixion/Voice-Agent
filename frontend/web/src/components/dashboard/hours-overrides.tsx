'use client';

import { type BusinessHours, type HoursProblem, MAX_INTERVALS_PER_DAY, hoursProblems, isOpen, nextOpeningAt } from '@portal/schemas';
import { Alert, Button, Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@portal/ui';
import { CalendarPlus, Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { type DateRow, dateRows, withDateRows } from '@/src/dashboard/hours-view';
import { localDate, shiftDate } from '@/src/lib/format';
import { timezoneLabel, timezones } from '@/src/lib/countries';

/** Radix refuses an empty item value; this stands for "no zone of its own". */
const WORKSPACE_ZONE = '__workspace__';

/**
 * D16 per-number hours, the part the weekly grid cannot say: the zone the schedule is
 * read in, and dates that differ from the week — a holiday closed all day, a short day
 * before one. Precedence is the inbound check's own (`intervalsOn`): a closed date, then a
 * special date, then the weekday. Problems are the API's (`hoursProblems`), so what this
 * flags is exactly what a save would refuse.
 */
export function HoursOverridesEditor({
  value,
  onChange,
  disabled,
  workspaceTimeZone,
  allowTimeZone,
}: {
  value: BusinessHours;
  onChange: (next: BusinessHours) => void;
  disabled?: boolean;
  workspaceTimeZone: string;
  /** A number's own schedule may keep its own zone; the workspace's always uses the workspace zone. */
  allowTimeZone?: boolean;
}) {
  const t = useTranslations('dashboard.hours');
  const th = useTranslations('wizard.w2.hours');
  const rows = dateRows(value);
  const zone = value.timezone ?? workspaceTimeZone;
  const zones = React.useMemo(() => {
    const all = timezones();
    return value.timezone && !all.includes(value.timezone) ? [value.timezone, ...all] : all;
  }, [value.timezone]);
  const problems = hoursProblems(value);

  function setRows(next: DateRow[]) {
    onChange(withDateRows(value, next));
  }
  function update(i: number, patch: Partial<DateRow>) {
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function addDate() {
    // The first day from tomorrow that is not already listed, in the schedule's own zone.
    let date = shiftDate(localDate(new Date(), zone), 1);
    while (rows.some((r) => r.date === date)) date = shiftDate(date, 1);
    setRows([...rows, { date, closed: true, intervals: [] }]);
  }

  return (
    <div className="flex flex-col gap-4">
      {allowTimeZone ? (
        <Field id="hours-zone" label={t('zone')} description={t('zoneHint')} className="sm:max-w-md">
          <Select value={value.timezone ?? WORKSPACE_ZONE} onValueChange={(v) => onChange({ ...value, timezone: v === WORKSPACE_ZONE ? undefined : v })} disabled={disabled}>
            <SelectTrigger id="hours-zone">
              <SelectValue placeholder={t('zoneWorkspace', { zone: timezoneLabel(workspaceTimeZone) })} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={WORKSPACE_ZONE}>{t('zoneWorkspace', { zone: timezoneLabel(workspaceTimeZone) })}</SelectItem>
              {zones.map((z) => (
                <SelectItem key={z} value={z}>
                  {timezoneLabel(z)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">{t('datesTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('datesBody')}</p>
          </div>
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={addDate}>
            <CalendarPlus /> {t('addDate')}
          </Button>
        </div>
        {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t('datesEmpty')}</p> : null}
        {rows.map((row, i) => {
          const past = row.date < localDate(new Date(), zone);
          return (
            <div key={`${row.date}-${i}`} className="flex flex-col gap-2 rounded-md border border-border p-2 sm:flex-row sm:items-start">
              <div className="flex flex-wrap items-center gap-2">
                <Input type="date" value={row.date} disabled={disabled} aria-label={t('date')} className="h-9 w-[10.5rem]" dir="ltr" onChange={(e) => e.target.value && update(i, { date: e.target.value })} />
                <Select value={row.closed ? 'closed' : 'hours'} onValueChange={(v) => update(i, v === 'closed' ? { closed: true, intervals: [] } : { closed: false, intervals: row.intervals.length ? row.intervals : [{ open: '09:00', close: '13:00' }] })} disabled={disabled}>
                  <SelectTrigger className="h-9 w-40" aria-label={t('kind')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="closed">{t('closedAllDay')}</SelectItem>
                    <SelectItem value="hours">{t('specialHours')}</SelectItem>
                  </SelectContent>
                </Select>
                {past ? <span className="text-xs text-muted-foreground">{t('past')}</span> : null}
              </div>
              <div className="flex flex-1 flex-col gap-2">
                {row.closed
                  ? null
                  : row.intervals.map((interval, k) => (
                      <div key={k} className="flex flex-wrap items-center gap-2">
                        <Input type="time" step={300} value={interval.open} disabled={disabled} aria-label={th('open')} className="h-9 w-[7.5rem]" dir="ltr" onChange={(e) => update(i, { intervals: row.intervals.map((x, j) => (j === k ? { ...x, open: e.target.value } : x)) })} />
                        <span className="text-xs text-muted-foreground">–</span>
                        <Input type="time" step={300} value={interval.close} disabled={disabled} aria-label={th('close')} className="h-9 w-[7.5rem]" dir="ltr" onChange={(e) => update(i, { intervals: row.intervals.map((x, j) => (j === k ? { ...x, close: e.target.value } : x)) })} />
                        {interval.close <= interval.open ? <span className="text-xs text-muted-foreground">{th('nextDay')}</span> : null}
                        {row.intervals.length > 1 ? (
                          <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t('removeHours')} onClick={() => update(i, { intervals: row.intervals.filter((_, j) => j !== k) })}>
                            <X />
                          </Button>
                        ) : null}
                        {k === row.intervals.length - 1 && row.intervals.length < Math.min(2, MAX_INTERVALS_PER_DAY) ? (
                          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => update(i, { intervals: [...row.intervals, { open: '15:00', close: '18:00' }] })}>
                            <Plus /> {th('addInterval')}
                          </Button>
                        ) : null}
                      </div>
                    ))}
              </div>
              <Button type="button" variant="ghost" size="icon-sm" className="self-end sm:self-start" disabled={disabled} aria-label={t('removeDate')} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <X />
              </Button>
            </div>
          );
        })}
      </div>

      {problems.length ? (
        <Alert variant="danger" title={t('problemsTitle')}>
          <ul className="list-disc ps-5">
            {problems.map((p, i) => (
              <li key={i}>{problemText(p, value, t, th)}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}

type T = ReturnType<typeof useTranslations>;

function problemText(problem: HoursProblem, hours: BusinessHours, t: T, th: T): string {
  const [area, index] = problem.path;
  const where =
    area === 'days' && typeof index === 'string'
      ? th(`days.${index}`)
      : area === 'date_overrides' && typeof index === 'number'
        ? (hours.date_overrides?.[index]?.date ?? '')
        : area === 'closed_dates' && typeof index === 'number'
          ? (hours.closed_dates[index] ?? '')
          : '';
  return t(`problems.${problem.kind}`, { where });
}

/**
 * "Open now" / "Closed now — opens …", from the same `isOpen` the inbound check calls, so
 * the preview is the answer a caller would get this minute.
 */
export function HoursStatusLine({ hours, workspaceTimeZone }: { hours: BusinessHours | null; workspaceTimeZone: string }) {
  const t = useTranslations('dashboard.hours');
  const th = useTranslations('wizard.w2.hours');
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!hours) return null;
  const verdict = isOpen(hours, now, workspaceTimeZone);
  const zone = timezoneLabel(hours.timezone ?? workspaceTimeZone);
  const local = verdict.clock?.time ?? '';
  if (verdict.open) return <p className="text-sm text-success-emphasis">{t('openNow', { time: local, zone })}</p>;
  const next = nextOpeningAt(hours, now, workspaceTimeZone);
  const when = !next ? null : next.offset === 0 ? t('today', { time: next.time }) : next.offset === 1 ? t('tomorrow', { time: next.time }) : t('onDay', { day: th(`days.${next.weekday}`), time: next.time });
  return <p className="text-sm text-warning-emphasis">{when ? t('closedNow', { time: local, zone, when }) : t('closedNowNoOpening', { time: local, zone })}</p>;
}
