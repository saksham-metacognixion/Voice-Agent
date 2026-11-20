import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The stream and the document's lifetime. `fetchEventSource` is replaced by a recorder:
 * what matters here is the signal it is handed, not what it does with it.
 */
const calls: Array<{ url: string; init: { signal: AbortSignal } }> = [];
vi.mock('@microsoft/fetch-event-source', () => ({
  EventStreamContentType: 'text/event-stream',
  fetchEventSource: (url: string, init: { signal: AbortSignal }) => {
    calls.push({ url, init });
    return new Promise<void>((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  },
}));

const { subscribeEvents } = await import('./sse');

const api = { baseUrl: 'http://api.test', options: { getToken: async () => 't', getWorkspaceId: () => 'ws' } } as never;

describe('subscribeEvents and the document lifetime', () => {
  let win: EventTarget;
  beforeEach(() => {
    calls.length = 0;
    win = new EventTarget();
    vi.stubGlobal('window', win);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('aborts the stream on pagehide, so a cached document holds no socket', () => {
    subscribeEvents(api, { onEvent: () => undefined });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.signal.aborted).toBe(false);
    win.dispatchEvent(new Event('pagehide'));
    expect(calls[0]!.init.signal.aborted).toBe(true);
  });

  it('unsubscribe aborts and stops listening, so a later pagehide touches nothing of its own', () => {
    const unsubscribe = subscribeEvents(api, { onEvent: () => undefined });
    unsubscribe();
    expect(calls[0]!.init.signal.aborted).toBe(true);
    // A second, live subscription is the only one pagehide should reach.
    subscribeEvents(api, { onEvent: () => undefined });
    win.dispatchEvent(new Event('pagehide'));
    expect(calls[1]!.init.signal.aborted).toBe(true);
  });

  it('narrows to the topics asked for', () => {
    subscribeEvents(api, { topics: ['wallet', 'call:abc'], onEvent: () => undefined });
    expect(calls[0]!.url).toBe('http://api.test/events?topics=wallet%2Ccall%3Aabc');
  });
});
