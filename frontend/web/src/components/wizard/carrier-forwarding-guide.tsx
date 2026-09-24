'use client';

import { useApi, useGetForwardingGuide } from '@portal/api-client';
import { carrier as carrierSchema, type Carrier } from '@portal/schemas';
import { Button, ErrorState, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Skeleton } from '@portal/ui';
import { useTranslations } from 'next-intl';
import { errorMessage } from '@/src/lib/errors';

export const CARRIERS = carrierSchema.options;

/**
 * W6 CarrierForwardingGuide (§11.2 Option B): the dial codes that send the customer's
 * existing line to the number we buy them, per carrier, from
 * `GET /numbers/forwarding-guide?carrier=` — content lives with the API, not here. The
 * new number does not exist until activation, so the guide says "your new number"
 * until then; the live page repeats it with the real one.
 */
export function CarrierForwardingGuide({ carrier, onCarrierChange, disabled }: { carrier: Carrier; onCarrierChange?: (c: Carrier) => void; disabled?: boolean }) {
  const t = useTranslations();
  const tg = useTranslations('wizard.w6.guide');
  const api = useApi();
  const guide = useGetForwardingGuide(api, { carrier }, { staleTime: 60 * 60_000 });

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-muted/30 p-4">
      {onCarrierChange ? (
        <div className="flex flex-col gap-1.5 sm:max-w-xs">
          <Label htmlFor="w6-carrier">{tg('carrier')}</Label>
          <Select value={carrier} onValueChange={(v) => onCarrierChange(v as Carrier)} disabled={disabled}>
            <SelectTrigger id="w6-carrier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CARRIERS.map((c) => (
                <SelectItem key={c} value={c}>
                  {tg(`carriers.${c}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {guide.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : guide.isError ? (
        <ErrorState title={t('errors.loadFailed')} description={errorMessage(guide.error, t)} action={<Button size="sm" onClick={() => void guide.refetch()}>{t('common.retry')}</Button>} />
      ) : guide.data ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{tg('turnOn')}</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {guide.data.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">{tg('turnOff')}</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {guide.data.disable_steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
          {guide.data.notes.length ? (
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
              {guide.data.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted-foreground sm:col-span-2">{tg('whenLive')}</p>
        </div>
      ) : null}
    </div>
  );
}
