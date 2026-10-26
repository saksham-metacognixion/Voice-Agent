'use client';

import type { VoiceResponse } from '@portal/schemas';
import { AudioButton, Badge, Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton, cn } from '@portal/ui';
import { Check, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useServerCopy } from '@/src/i18n/server-copy';
import * as React from 'react';
import { languageName } from '@/src/wizard/languages';

export interface VoiceFilters {
  gender: 'male' | 'female' | 'neutral' | '';
  tier: 'standard' | 'premium' | '';
  /** "Native accents only" — drop the voices that would read the language with an accent. */
  native: boolean;
  q: string;
}

export interface VoicePickerProps {
  voices: VoiceResponse[];
  loading: boolean;
  selectedId: string | null;
  filters: VoiceFilters;
  onFiltersChange: (f: VoiceFilters) => void;
  onSelect: (voice: VoiceResponse) => void;
  /** The agent's main language, for the two group headings. */
  language: string;
  /** W3's Speed slider, applied to the sample so the dial can be heard. */
  rate?: number;
  onPreview: (voice: VoiceResponse, kind: 'sample' | 'greeting') => void;
  onPreviewError: (error: unknown) => void;
  disabled?: boolean;
}

/** W3 VoicePicker: filters on top, one row per voice with tier badge, sample and greeting buttons. */
export function VoicePicker({ voices, loading, selectedId, filters, onFiltersChange, onSelect, language, rate, onPreview, onPreviewError, disabled }: VoicePickerProps) {
  const t = useTranslations('wizard.w3');
  const tc = useTranslations('common');
  const copy = useServerCopy();
  const audioLabels = { play: tc('play'), pause: tc('pause'), unavailable: tc('sampleUnavailable'), loading: tc('loading') };
  const hasFilters = filters.gender || filters.tier || filters.native || filters.q;
  // The catalogue is a few hundred rows: show a page at a time, the chosen voice always first.
  const PAGE = 24;
  const [visible, setVisible] = React.useState(PAGE);
  const filterKey = `${filters.gender}|${filters.tier}|${filters.native}|${filters.q}|${language}|${voices.length}`;
  React.useEffect(() => setVisible(PAGE), [filterKey]);
  // The server returns the voices that sound native in the chosen language first; keep
  // that order, with the chosen voice pinned to the top so it never scrolls away.
  const filtered = React.useMemo(() => {
    const chosen = voices.find((v) => v.id === selectedId);
    return chosen ? [chosen, ...voices.filter((v) => v.id !== selectedId)] : voices;
  }, [voices, selectedId]);
  const shown = filtered.slice(0, visible);
  const remaining = filtered.length - shown.length;
  // Where the "also speaks" heading goes: the first card that is not native to the
  // chosen language. Only shown when both groups are on screen.
  const firstNonNative = shown.findIndex((v) => !v.native);
  const showGroups = firstNonNative > 0 && !filters.native;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative sm:w-56">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label={t('search')} placeholder={t('search')} value={filters.q} className="ps-9" onChange={(e) => onFiltersChange({ ...filters, q: e.target.value })} />
        </div>
        <Select value={filters.gender || 'all'} onValueChange={(v) => onFiltersChange({ ...filters, gender: v === 'all' ? '' : (v as VoiceFilters['gender']) })}>
          <SelectTrigger className="sm:w-36" aria-label={t('filters.gender')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('filters.gender')}: {t('filters.all')}</SelectItem>
            <SelectItem value="female">{t('filters.female')}</SelectItem>
            <SelectItem value="male">{t('filters.male')}</SelectItem>
            <SelectItem value="neutral">{t('filters.neutral')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.tier || 'all'} onValueChange={(v) => onFiltersChange({ ...filters, tier: v === 'all' ? '' : (v as VoiceFilters['tier']) })}>
          <SelectTrigger className="sm:w-36" aria-label={t('filters.tier')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('filters.tier')}: {t('filters.all')}</SelectItem>
            <SelectItem value="standard">{tc('standard')}</SelectItem>
            <SelectItem value="premium">{tc('premium')}</SelectItem>
          </SelectContent>
        </Select>
        <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-input bg-card px-3 text-sm shadow-card">
          <input type="checkbox" className="size-4 accent-primary" checked={filters.native} onChange={(e) => onFiltersChange({ ...filters, native: e.target.checked })} />
          {t('filters.native', { language: languageName(language) })}
        </label>
        {hasFilters ? (
          <Button variant="link" size="sm" onClick={() => onFiltersChange({ gender: '', tier: '', native: false, q: '' })}>
            {t('filters.clear')}
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{hasFilters ? t('empty') : t('emptyAll')}</p>
      ) : (
        // A list of cards, not a listbox: each card holds two controls (choose, hear), and an
        // option may not contain focusable children. The choice is the button's aria-pressed.
        <ul className="flex flex-col gap-2" aria-label={t('voices')}>
          {showGroups ? (
            <li aria-hidden className="pt-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('groups.native', { language: languageName(language) })}
            </li>
          ) : null}
          {shown.map((voice, index) => {
            const active = voice.id === selectedId;
            return (
              <React.Fragment key={voice.id}>
                {showGroups && index === firstNonNative ? (
                  <li aria-hidden className="pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {t('groups.alsoSpeaks', { language: languageName(language) })}
                  </li>
                ) : null}
              <li data-testid="voice-card">
                <div
                  className={cn(
                    'flex items-center gap-3 rounded-lg border bg-card p-3 shadow-card transition-[border-color,box-shadow]',
                    active ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:border-primary/40',
                  )}
                >
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={active}
                    onClick={() => onSelect(voice)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-md"
                  >
                    <span
                      className={cn(
                        'flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
                        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                      )}
                      aria-hidden
                    >
                      {active ? <Check className="size-4" /> : voice.name.slice(0, 1)}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium">{voice.name}</span>
                        {voice.tier === 'premium' ? <Badge variant="premium">{tc('premium')} · {tc('premiumRate')}</Badge> : <Badge variant="outline">{tc('standard')}</Badge>}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {[voice.gender ? t(`filters.${voice.gender}` as never) : null, voice.accent ? t('accent', { accent: copy.accent(voice.accent) }) : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <AudioButton
                      size="sm"
                      src={voice.preview_url}
                      rate={rate}
                      labels={audioLabels}
                      onPlay={() => onPreview(voice, 'sample')}
                      onError={onPreviewError}
                      title={t('hearSample')}
                      aria-label={`${t('hearSample')} – ${voice.name}`}
                    />
                  </div>
                </div>
              </li>
              </React.Fragment>
            );
          })}
          {remaining > 0 ? (
            <li className="flex justify-center pt-2">
              <Button type="button" variant="outline" onClick={() => setVisible((v) => v + PAGE)}>
                {t('showMore', { count: remaining })}
              </Button>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
