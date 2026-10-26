'use client';

import type { RetellLanguage } from '@portal/schemas';
import { Badge, Button, Field, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@portal/ui';
import { Check, Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { choosePrimary, languageName, sortedLanguages, type LanguageChoice } from '@/src/wizard/languages';

export interface LanguagePickerProps {
  primary: RetellLanguage;
  languages: RetellLanguage[];
  /** Every change carries both halves, so the caller saves once (QA-011). */
  onChange: (next: LanguageChoice) => void;
  disabled?: boolean;
}

const MAX_EXTRA = 4;

/** W3 — main language (select) and "also speaks" (chips, up to four). */
export function LanguagePicker({ primary, languages, onChange, disabled }: LanguagePickerProps) {
  const t = useTranslations('wizard.w3');
  const all = React.useMemo(sortedLanguages, []);
  const [adding, setAdding] = React.useState(false);
  const extras = languages.filter((l) => l !== primary);
  const full = extras.length >= MAX_EXTRA;

  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field id="primary-language" label={t('primaryLanguage')} description={t('primaryHint')}>
        <Select
          value={primary}
          disabled={disabled}
          onValueChange={(v) => onChange(choosePrimary(v as RetellLanguage, languages))}
        >
          <SelectTrigger id="primary-language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {all.map((code) => (
              <SelectItem key={code} value={code}>
                {languageName(code)} <span className="text-muted-foreground">({code})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t('alsoSpeaks')} description={full ? t('alsoSpeaksMax') : t('alsoSpeaksHint')}>
        <div className="flex min-h-10 flex-wrap items-center gap-1.5">
          {extras.map((code) => (
            <Badge key={code} variant="primary" className="h-7 gap-1 ps-2.5 pe-1 text-xs">
              {languageName(code)}
              <button
                type="button"
                disabled={disabled}
                aria-label={`${t('filters.clear')} ${languageName(code)}`}
                className="rounded-full p-0.5 hover:bg-primary/20"
                onClick={() => onChange({ primary_language: primary, languages: extras.filter((l) => l !== code) })}
              >
                <X className="size-3" aria-hidden />
              </button>
            </Badge>
          ))}
          {!full ? (
            adding ? (
              <Select
                open
                onOpenChange={(o) => !o && setAdding(false)}
                value=""
                disabled={disabled}
                onValueChange={(v) => {
                  onChange({ primary_language: primary, languages: [...extras, v as RetellLanguage].slice(0, MAX_EXTRA) });
                  setAdding(false);
                }}
              >
                <SelectTrigger className="h-7 w-48 text-xs">
                  <SelectValue placeholder={t('alsoSpeaks')} />
                </SelectTrigger>
                <SelectContent>
                  {all
                    .filter((c) => c !== primary && !extras.includes(c))
                    .map((code) => (
                      <SelectItem key={code} value={code}>
                        {languageName(code)} <span className="text-muted-foreground">({code})</span>
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            ) : (
              <Button type="button" variant="outline" size="sm" className={cn('h-7 text-xs')} disabled={disabled} onClick={() => setAdding(true)}>
                <Plus /> {t('alsoSpeaks')}
              </Button>
            )
          ) : (
            <Check className="size-4 text-success" aria-hidden />
          )}
        </div>
      </Field>
    </div>
  );
}
