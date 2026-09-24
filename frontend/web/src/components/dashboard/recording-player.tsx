'use client';

import { getCallRecording, isApiError, useApi } from '@portal/api-client';
import { Button } from '@portal/ui';
import { Play } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';

/**
 * D2 recording (ADR 0011 §5): `GET /calls/:id/recording` mints a signed one-hour link to
 * our own streaming route, which the `<audio>` element plays. The platform URL never
 * reaches the browser. The link is asked for on demand — a drawer opened to read a
 * transcript should not mint one — and re-minted when playback fails after it expired.
 */
export function RecordingPlayer({ callId, available }: { callId: string; available: boolean }) {
  const t = useTranslations('dashboard.calls.recording');
  const tc = useTranslations();
  const api = useApi();
  const [state, setState] = React.useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; url: string | null; expiresAt: number; error: string | null }>({ status: 'idle', url: null, expiresAt: 0, error: null });

  async function load() {
    setState((s) => ({ ...s, status: 'loading', error: null }));
    try {
      const res = await getCallRecording(api, { id: callId });
      setState({ status: 'ready', url: res.url, expiresAt: Date.parse(res.expires_at), error: null });
    } catch (e) {
      setState({ status: 'error', url: null, expiresAt: 0, error: isApiError(e, 'NOT_FOUND') ? t('unavailable') : errorMessage(e, tc) });
    }
  }

  if (!available) return <p className="text-sm text-muted-foreground">{t('none')}</p>;

  if (state.status === 'ready' && state.url) {
    return (
      <div className="flex flex-col gap-2">
        <audio
          controls
          preload="metadata"
          src={state.url}
          className="w-full"
          onError={() => {
            // The signed link lasts an hour; past that, a fresh one is one click away.
            setState({ status: 'error', url: null, expiresAt: 0, error: Date.now() > state.expiresAt ? t('expired') : t('playbackError') });
          }}
        >
          {t('noAudioSupport')}
        </audio>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" size="sm" className="w-fit" loading={state.status === 'loading'} onClick={() => void load()}>
        <Play /> {state.status === 'error' ? tc('common.retry') : t('load')}
      </Button>
      {state.status === 'error' && state.error ? <p className="text-xs text-danger">{state.error}</p> : null}
    </div>
  );
}
