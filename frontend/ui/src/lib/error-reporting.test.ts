import type { ErrorEvent } from '@sentry/react';
import { describe, expect, it } from 'vitest';
import { scrubBreadcrumb, scrubBrowserEvent, stripUrl } from './error-reporting';

describe('browser error scrubbing', () => {
  it('drops query strings and fragments — invite tokens, view-as keys, recording tokens', () => {
    expect(stripUrl('https://app.oraly.ai/invite/?token=abc')).toBe('https://app.oraly.ai/invite/');
    expect(stripUrl('https://app.oraly.ai/impersonate/#session=s&key=k')).toBe('https://app.oraly.ai/impersonate/');
    expect(stripUrl('/calls/c1/recording/stream?token=t')).toBe('/calls/c1/recording/stream');
    expect(stripUrl('https://app.oraly.ai/app/')).toBe('https://app.oraly.ai/app/');
  });

  it('keeps only the user agent on the event request', () => {
    const event = scrubBrowserEvent({
      type: undefined,
      request: {
        url: 'https://app.oraly.ai/invite/?token=abc',
        query_string: 'token=abc',
        headers: { 'User-Agent': 'Safari', Referer: 'https://app.oraly.ai/impersonate/#key=k' },
      },
    } as ErrorEvent);
    expect(event.request).toEqual({ url: 'https://app.oraly.ai/invite/', headers: { 'User-Agent': 'Safari' } });
  });

  it('strips navigation and fetch breadcrumb URLs', () => {
    expect(scrubBreadcrumb({ category: 'navigation', data: { from: '/invite/?token=a', to: '/app/?call=c' } })?.data).toEqual({
      from: '/invite/',
      to: '/app/',
    });
    expect(scrubBreadcrumb({ category: 'fetch', data: { url: 'https://api/x?token=t', status_code: 200 } })?.data).toEqual({
      url: 'https://api/x',
      status_code: 200,
    });
  });
});
