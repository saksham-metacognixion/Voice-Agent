'use client';

import type { TemplateSummary } from '@portal/schemas';
import { AudioButton, Badge, Skeleton, cn } from '@portal/ui';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { track } from '@/src/analytics/posthog';

export interface TemplatePickerProps {
  templates: TemplateSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
}

/**
 * W1 cards. Keyboard: each card is a button; the selected one is `aria-pressed`.
 * The select button is an overlay stretched across the card rather than the card
 * itself — the card carries the "hear sample" control, and a <button> may not
 * contain a <button>. Static content is `pointer-events-none` so a click anywhere
 * on the card reaches the overlay; the sample control opts back in above it.
 */
export function TemplatePicker({ templates, selected, onSelect, disabled }: TemplatePickerProps) {
  const t = useTranslations();
  return (
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" role="list">
      {templates.map((tpl) => {
        const active = tpl.id === selected;
        return (
          <li key={tpl.id} className="h-full">
            <div
              className={cn(
                'group relative flex h-full w-full flex-col gap-3 rounded-lg border bg-card p-5 text-left shadow-card transition-[border-color,box-shadow,transform]',
                'hover:border-primary/40 hover:shadow-popover has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                disabled && 'opacity-60',
                active ? 'border-primary ring-2 ring-primary/20' : 'border-border',
              )}
            >
              <button
                type="button"
                disabled={disabled}
                aria-pressed={active}
                aria-label={tpl.name}
                onClick={() => onSelect(tpl.id)}
                className="absolute inset-0 z-0 rounded-lg outline-none disabled:cursor-not-allowed"
              />
              <div className="pointer-events-none relative z-10 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold leading-tight">{tpl.name}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{tpl.tagline}</p>
                </div>
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors',
                    active ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-card text-transparent group-hover:border-primary/50',
                  )}
                  aria-hidden
                >
                  <Check className="size-3.5" />
                </span>
              </div>
              <p className="pointer-events-none relative z-10 text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">{t('wizard.w1.bestFor')}:</span> {tpl.best_for}
              </p>
              <div className="pointer-events-none relative z-10 mt-auto flex items-center justify-between gap-2 pt-1">
                <div className="flex flex-wrap gap-1.5">
                  {tpl.default_tier === 'premium' ? <Badge variant="premium">{t('common.premium')}</Badge> : <Badge variant="outline">{t('common.standard')}</Badge>}
                  {tpl.industry_tags.slice(0, 2).map((tag) => (
                    <Badge key={tag} variant="default" className="capitalize">
                      {tag}
                    </Badge>
                  ))}
                </div>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="hidden sm:inline">{t('wizard.w1.hearSample')}</span>
                  <AudioButton
                    size="sm"
                    className="pointer-events-auto"
                    disabled={disabled}
                    src={tpl.sample_audio_url}
                    onPlay={() => track('template_sample_played', { template_id: tpl.id })}
                    labels={{ play: t('common.play'), pause: t('common.pause'), unavailable: t('common.sampleUnavailable'), loading: t('common.loading') }}
                  />
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function TemplatePickerSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-44" />
      ))}
    </div>
  );
}
