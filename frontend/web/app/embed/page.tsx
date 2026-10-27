'use client';

import { createApiClient, getWidgetConfig } from '@portal/api-client';
import type { WidgetConfig } from '@portal/schemas';
import { Button, cn } from '@portal/ui';
import { Mic, PhoneOff } from 'lucide-react';
import { NextIntlClientProvider, useTranslations } from 'next-intl';
import * as React from 'react';
import { config } from '@/src/config';
import { intlLocale, localeDirection, messages, type Locale } from '@/src/i18n';
import { useLocaleChoice } from '@/src/i18n/locale-provider';
import { FRAME_MAX_PX, FRAME_PADDING_PX, HIDDEN_FRAME, type FrameSize, frameSize } from '@/src/widget/frame-size';
import { useWidgetCall, type WidgetCallFailure } from '@/src/widget/use-widget-call';

/** The widest the button may grow inside the loader's cap; a longer name still ends in "…". */
const BUTTON_MAX_PX = FRAME_MAX_PX - 2 * FRAME_PADDING_PX;

/**
 * D17 §11.5: the website widget's frame, `/embed/?key=`. Loaded by `widget.js` on the
 * customer's site in an iframe allowed the microphone; opened on its own (D3's "Preview")
 * it centres itself and only shows the button. A call from there would be a real website
 * call (`metadata.test = false`): billed, counted as a visitor, toasted as one — and
 * refused anyway once the widget lists its sites, since an unframed page has no parent
 * origin to send. The owner talks to the agent from the Test tab. No guard and no session: `Providers` gives this route theme and
 * language only, and the API client here sends no token and no workspace. The button
 * speaks the agent's language once the config arrives, not the visitor's stored choice.
 *
 * Every refusal from the API reads the same to the visitor ("not available right now"),
 * except a full microphone or a busy budget, which they can act on.
 */
export default function EmbedPage() {
  const [key, setKey] = React.useState<string | null>(null);
  const [widget, setWidget] = React.useState<WidgetConfig | null | 'missing'>(null);
  const api = React.useMemo(() => createApiClient({ baseUrl: config.apiUrl, getToken: async () => null, getWorkspaceId: () => null }), []);
  const visitor = useLocaleChoice().locale;

  React.useEffect(() => {
    const k = new URLSearchParams(window.location.search).get('key');
    setKey(k);
    // The page behind the frame shows through.
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    if (!k) {
      setWidget('missing');
      return;
    }
    getWidgetConfig(api, { key: k })
      .then(setWidget)
      .catch(() => setWidget('missing'));
  }, [api]);

  const locale: Locale = widget && widget !== 'missing' ? (widget.language.toLowerCase().startsWith('ar') ? 'ar' : 'en') : visitor;
  React.useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = localeDirection(locale);
  }, [locale]);

  return (
    <NextIntlClientProvider locale={intlLocale(locale)} messages={messages[locale]} timeZone="UTC">
      <EmbedButton widgetKey={key} widget={widget} api={api} />
    </NextIntlClientProvider>
  );
}

function EmbedButton({ widgetKey, widget, api }: { widgetKey: string | null; widget: WidgetConfig | null | 'missing'; api: ReturnType<typeof createApiClient> }) {
  const t = useTranslations('embed');
  const framed = typeof window !== 'undefined' && window.parent !== window;
  const { state, start, end } = useWidgetCall(api, framed && widget && widget !== 'missing' ? widgetKey : null);
  const busy = state.status === 'mic' || state.status === 'connecting';
  const open = state.status === 'live' || state.status === 'ended' || state.status === 'failed';
  const content = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState<FrameSize>(HIDDEN_FRAME);

  // The frame follows what it shows, measured (`frameSize`). The box is `w-max shrink-0`,
  // so resizing the frame never resizes it back and the observer settles at once.
  React.useLayoutEffect(() => {
    const el = content.current;
    if (!el) {
      setSize(HIDDEN_FRAME);
      return;
    }
    const measure = () => {
      const next = frameSize(el.getBoundingClientRect());
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [widget]);

  React.useEffect(() => {
    if (framed && widget !== null) window.parent.postMessage({ type: 'oraly-widget:size', ...size }, '*');
  }, [framed, widget, size]);

  if (widget === null) return null;
  if (widget === 'missing') return framed ? null : <p className="p-6 text-sm text-muted-foreground">{t('missing')}</p>;

  const name = widget.business_name;
  return (
    <div className={cn('flex p-3', framed ? 'fixed inset-0 items-end justify-end' : 'min-h-dvh flex-col items-center justify-center gap-3')}>
      {!framed ? <p className="text-xs text-muted-foreground">{t('preview')}</p> : null}
      <div ref={content} className="w-max shrink-0">
      {open ? (
        <div className="flex w-[276px] flex-col gap-2 rounded-2xl border border-border bg-card p-3 text-card-foreground shadow-lg" aria-live="polite">
          <p className="break-words text-sm font-medium">{state.status === 'live' ? (state.agentTalking ? t('speaking', { agent: widget.agent_name }) : t('live', { business: name })) : state.status === 'ended' ? t('ended') : <FailureLine failure={state.failure} />}</p>
          {state.status === 'live' ? <p className="text-xs tabular-nums text-muted-foreground">{clock(state.elapsedS)}</p> : null}
          {state.status === 'live' ? (
            <Button variant="danger" size="sm" onClick={end}>
              <PhoneOff /> {t('hangUp')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => void start()}>
              <Mic /> {t('again')}
            </Button>
          )}
        </div>
      ) : (
        <Button className="rounded-full shadow-lg" style={{ maxWidth: BUTTON_MAX_PX }} onClick={() => void start()} loading={busy} disabled={busy || !framed}>
          {busy ? null : <Mic />} <span className="truncate">{busy ? t('connecting') : t('talk', { business: name })}</span>
        </Button>
      )}
      </div>
    </div>
  );
}

function FailureLine({ failure }: { failure: WidgetCallFailure | null }) {
  const t = useTranslations('embed.errors');
  if (failure?.kind === 'mic_denied') return <>{t('micDenied')}</>;
  if (failure?.kind === 'mic_missing') return <>{t('micMissing')}</>;
  if (failure?.kind === 'api' && failure.code === 'RATE_LIMITED') return <>{t('busy')}</>;
  if (failure?.kind === 'api') return <>{t('unavailable')}</>;
  return <>{t('connection')}</>;
}

function clock(totalS: number): string {
  return `${Math.floor(totalS / 60)}:${String(totalS % 60).padStart(2, '0')}`;
}
