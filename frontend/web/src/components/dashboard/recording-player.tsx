'use client';

import { getCallRecording, isApiError, useApi } from '@portal/api-client';
import { Button, toast } from '@portal/ui';
import { Download, Play } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { errorMessage } from '@/src/lib/errors';

/**
 * D2 recording (ADR 0011 §5): `GET /calls/:id/recording` mints a signed one-hour link to
 * our own streaming route, which the `<audio>` element plays. The platform URL never
 * reaches the browser. The link is asked for on demand — a drawer opened to read a
 * transcript should not mint one — and re-minted when playback fails after it expired.
 *
 * Spec D2 "Download (Owner/Admin)" (QA-077): `canDownload` adds a button that fetches the
 * file through the same proxy (`download_url`, `Content-Disposition: attachment`). The
 * API mints that link for an owner or admin only and refuses it to anyone else.
 */
export function RecordingPlayer({ callId, available, canDownload = false }: { callId: string; available: boolean; canDownload?: boolean }) {
  const t = useTranslations('dashboard.calls.recording');
  const tc = useTranslations();
  const api = useApi();
  const [state, setState] = React.useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; url: string | null; expiresAt: number; error: string | null }>({ status: 'idle', url: null, expiresAt: 0, error: null });
  const [download, setDownload] = React.useState<{ url: string; expiresAt: number } | null>(null);
  const [downloading, setDownloading] = React.useState(false);

  async function load() {
    setState((s) => ({ ...s, status: 'loading', error: null }));
    try {
      const res = await getCallRecording(api, { id: callId });
      setState({ status: 'ready', url: res.url, expiresAt: Date.parse(res.expires_at), error: null });
      setDownload(res.download_url ? { url: res.download_url, expiresAt: Date.parse(res.expires_at) } : null);
    } catch (e) {
      setState({ status: 'error', url: null, expiresAt: 0, error: isApiError(e, 'NOT_FOUND') ? t('unavailable') : errorMessage(e, tc) });
    }
  }

  async function save() {
    if (downloading) return;
    setDownloading(true);
    try {
      // A link with a minute or less left is minted again: the download may take that long to start.
      let url = download && download.expiresAt - Date.now() > 60_000 ? download.url : null;
      if (!url) {
        const res = await getCallRecording(api, { id: callId });
        if (res.download_url) setDownload({ url: res.download_url, expiresAt: Date.parse(res.expires_at) });
        url = res.download_url;
      }
      if (!url) throw new Error('no download link');
      // The response is an attachment, so following it saves the file and leaves the page as it is.
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      toast.error(isApiError(e, 'NOT_FOUND') ? t('unavailable') : errorMessage(e, tc));
    } finally {
      setDownloading(false);
    }
  }

  if (!available) return <p className="text-sm text-muted-foreground">{t('none')}</p>;

  const downloadButton = canDownload ? (
    <Button variant="outline" size="sm" className="w-fit" loading={downloading} onClick={() => void save()}>
      {downloading ? null : <Download aria-hidden />} {t('download')}
    </Button>
  ) : null;

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
        {downloadButton}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" className="w-fit" loading={state.status === 'loading'} onClick={() => void load()}>
          <Play /> {state.status === 'error' ? tc('common.retry') : t('load')}
        </Button>
        {downloadButton}
      </div>
      {state.status === 'error' && state.error ? <p className="text-xs text-danger">{state.error}</p> : null}
    </div>
  );
}
