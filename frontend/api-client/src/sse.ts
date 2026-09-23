import { fetchEventSource, EventStreamContentType } from '@microsoft/fetch-event-source';
import { sseEvent, type SseEvent } from '@portal/schemas';
import type { ApiClient } from './client';

export interface SubscribeOptions {
  /** Narrow to these topics; omitted = every topic of the workspace. */
  topics?: string[];
  onEvent: (event: SseEvent) => void;
  /** Connection-level state, for the "live" dot and the polling fallback. */
  onOpen?: () => void;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
}

/**
 * `GET /events` over `@microsoft/fetch-event-source` — plain `EventSource` cannot send
 * `Authorization` or `X-Workspace-Id` (CLAUDE.md). The token is re-read on every
 * reconnect so a rotated access token does not strand the stream. Reconnect is the
 * library's, with the server's `retry:` hint; a 401/403 stops it, because retrying an
 * unauthenticated stream every three seconds is a login loop.
 *
 * Returns the unsubscribe function. Frames are parsed against `sseEvent`; a frame the
 * schema rejects is dropped, never thrown into React.
 */
export function subscribeEvents(api: ApiClient, opts: SubscribeOptions): () => void {
  const controller = new AbortController();
  const signal = opts.signal ? anySignal([opts.signal, controller.signal]) : controller.signal;
  const query = opts.topics && opts.topics.length > 0 ? `?topics=${encodeURIComponent(opts.topics.join(','))}` : '';

  class FatalError extends Error {}

  void fetchEventSource(`${api.baseUrl}/events${query}`, {
    signal,
    openWhenHidden: true,
    async fetch(input, init) {
      const token = await api.options.getToken();
      const ws = api.options.getWorkspaceId();
      const headers = new Headers(init?.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      if (ws) headers.set('X-Workspace-Id', ws);
      return (api.options.fetch ?? fetch)(input, { ...init, headers });
    },
    async onopen(response) {
      if (response.ok && (response.headers.get('content-type') ?? '').startsWith(EventStreamContentType)) {
        opts.onOpen?.();
        return;
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new FatalError(`events stream refused: ${response.status}`);
      }
      throw new Error(`events stream failed: ${response.status}`);
    },
    onmessage(message) {
      if (!message.data) return;
      try {
        const parsed = sseEvent.safeParse(JSON.parse(message.data));
        if (parsed.success) opts.onEvent(parsed.data);
      } catch {
        /* a malformed frame is dropped */
      }
    },
    onerror(error) {
      opts.onError?.(error);
      if (error instanceof FatalError) throw error; // stop retrying
      return 3000;
    },
    onclose() {
      // The server closed a healthy stream (deploy, idle proxy): retry.
      throw new Error('events stream closed');
    },
  }).catch(() => {
    /* aborted or fatal; either way the caller's unsubscribe/onError has the story */
  });

  return () => controller.abort();
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}
