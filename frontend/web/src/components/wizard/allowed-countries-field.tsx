'use client';

import { Badge, Field, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@portal/ui';
import { X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { COUNTRIES, countryName } from '@/src/lib/countries';

/** `routing.allowed_countries` takes at most 20 (the request schema's `max(20)`). */
export const MAX_ALLOWED_COUNTRIES = 20;

/**
 * §8 W6 "Allowed caller countries" (Z-45): chips for the countries whose callers the
 * number answers, a select to add one. Enforced by the §13.9 check (ADR 0035), which
 * declines anyone else at no cost; an empty list means no restriction, and the copy
 * says so. The same shape as D4's Callers section, without its server-sync dance: W6
 * saves the whole plan on Continue.
 */
export function AllowedCountriesField({ id, value, onChange, disabled }: { id: string; value: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const t = useTranslations('wizard.w6.callers');
  const [adding, setAdding] = React.useState('');
  return (
    <div className="flex flex-col gap-3" data-testid="allowed-countries">
      <div>
        <p className="text-sm font-medium">{t('title')}</p>
        <p className="text-xs text-muted-foreground">{value.length ? t('body') : t('empty')}</p>
      </div>
      {value.length ? (
        <ul className="flex flex-wrap gap-2" aria-label={t('title')}>
          {value.map((code) => (
            <li key={code}>
              <Badge variant="outline" className="gap-1 py-1 ps-2.5 pe-1 text-sm">
                {countryName(code)}
                <button type="button" className="rounded p-0.5 hover:bg-muted disabled:cursor-not-allowed" aria-label={t('remove', { country: countryName(code) })} disabled={disabled} onClick={() => onChange(value.filter((c) => c !== code))}>
                  <X className="size-3.5" aria-hidden />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {value.length < MAX_ALLOWED_COUNTRIES ? (
        <Field id={id} label={t('add')} className="sm:max-w-xs">
          <Select
            value={adding}
            onValueChange={(code) => {
              if (code && !value.includes(code)) onChange([...value, code]);
              setAdding('');
            }}
            disabled={disabled}
          >
            <SelectTrigger id={id}>
              <SelectValue placeholder={t('add')} />
            </SelectTrigger>
            <SelectContent>
              {COUNTRIES.filter((c) => !value.includes(c.code)).map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {countryName(c.code)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : (
        <p className="text-xs text-muted-foreground">{t('max', { max: MAX_ALLOWED_COUNTRIES })}</p>
      )}
    </div>
  );
}
