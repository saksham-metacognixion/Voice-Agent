'use client';

import type { BusinessHours, Weekday } from '@portal/schemas';
import { Button, Input, Switch, cn } from '@portal/ui';
import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

const DAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface HoursEditorProps {
  value: BusinessHours | undefined;
  onChange: (next: BusinessHours) => void;
  disabled?: boolean;
}

/**
 * W2 #3 — HoursEditor. One row per weekday: an open/closed switch and 1–2 intervals in
 * 24-hour HH:MM. A day with no intervals is closed (`businessHours` in @portal/schemas).
 */
export function HoursEditor({ value, onChange, disabled }: HoursEditorProps) {
  const t = useTranslations('wizard.w2.hours');
  const days = value?.days ?? {};

  function setDay(day: Weekday, intervals: Array<{ open: string; close: string }>) {
    const nextDays = { ...days };
    if (intervals.length === 0) delete nextDays[day];
    else nextDays[day] = intervals;
    onChange({ ...(value ?? { closed_dates: [] }), days: nextDays, closed_dates: value?.closed_dates ?? [] });
  }

  function copyMondayToWeekdays() {
    const mon = days.mon ?? [];
    const nextDays = { ...days };
    for (const d of ['tue', 'wed', 'thu', 'fri'] as Weekday[]) {
      if (mon.length === 0) delete nextDays[d];
      else nextDays[d] = mon.map((i) => ({ ...i }));
    }
    onChange({ ...(value ?? { closed_dates: [] }), days: nextDays, closed_dates: value?.closed_dates ?? [] });
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-card">
      {DAYS.map((day) => {
        const intervals = days[day] ?? [];
        const open = intervals.length > 0;
        return (
          <div key={day} className={cn('flex flex-col gap-2 rounded-md px-2 py-1.5 sm:flex-row sm:items-start', open ? '' : 'text-muted-foreground')}>
            <div className="flex w-28 shrink-0 items-center gap-3 pt-1.5">
              <Switch
                checked={open}
                disabled={disabled}
                aria-label={`${t(`days.${day}`)} ${open ? t('open') : t('closed')}`}
                onCheckedChange={(on) => setDay(day, on ? [{ open: '09:00', close: '17:00' }] : [])}
              />
              <span className="text-sm font-medium">{t(`days.${day}`)}</span>
            </div>
            <div className="flex flex-1 flex-col gap-2">
              {open ? (
                intervals.map((interval, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input
                      type="time"
                      step={300}
                      value={interval.open}
                      disabled={disabled}
                      aria-label={t('open')}
                      className="h-9 w-[7.5rem]"
                      onChange={(e) => setDay(day, intervals.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))}
                    />
                    <span className="text-xs text-muted-foreground">–</span>
                    <Input
                      type="time"
                      step={300}
                      value={interval.close}
                      disabled={disabled}
                      aria-label={t('close')}
                      className="h-9 w-[7.5rem]"
                      onChange={(e) => setDay(day, intervals.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))}
                    />
                    {interval.close <= interval.open ? <span className="text-xs text-muted-foreground">{t('nextDay')}</span> : null}
                    {intervals.length > 1 ? (
                      <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t('closed')} onClick={() => setDay(day, intervals.filter((_, j) => j !== i))}>
                        <X />
                      </Button>
                    ) : null}
                    {i === intervals.length - 1 && intervals.length < 2 ? (
                      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => setDay(day, [...intervals, { open: '18:00', close: '21:00' }])}>
                        <Plus /> {t('addInterval')}
                      </Button>
                    ) : null}
                  </div>
                ))
              ) : (
                <span className="pt-2 text-sm">{t('closed')}</span>
              )}
            </div>
          </div>
        );
      })}
      <div className="flex justify-end border-t border-border pt-2">
        <Button type="button" variant="link" size="sm" disabled={disabled} onClick={copyMondayToWeekdays}>
          {t('copyToAll')}
        </Button>
      </div>
    </div>
  );
}
