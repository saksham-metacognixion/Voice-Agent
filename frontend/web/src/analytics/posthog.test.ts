import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/*
 * QA-008: the wiring, with the SDK replaced by a recorder. The sanitiser itself is
 * sanitize.test.ts; this proves every capture path goes through it.
 */
const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  register: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
}));
vi.mock('posthog-js', () => ({ default: sdk }));

beforeAll(() => {
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test');
  vi.stubGlobal('window', { location: { origin: 'https://app.oraly.ai', href: 'https://app.oraly.ai/invite/?token=SECRET_TEST_TOKEN' } });
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('PostHog initialisation (QA-008)', () => {
  it('installs the sanitiser as before_send and keeps replay, heatmaps and /flags off', async () => {
    const { initAnalytics } = await import('./posthog');
    const { sanitizeCapture } = await import('./sanitize');
    expect(initAnalytics()).toBe(true);
    const options = sdk.init.mock.calls[0]![1] as Record<string, unknown>;
    expect(options.before_send).toBe(sanitizeCapture);
    expect(options.disable_session_recording).toBe(true);
    expect(options.enable_heatmaps).toBe(false);
    // `/flags` posts person properties ($initial_current_url) outside before_send.
    expect(options.advanced_disable_flags).toBe(true);
    // Page leave stays on: it is sanitised like every other event, not switched off.
    expect(options.capture_pageleave).toBe(true);
  });

  it('the page view on /invite/?token= never hands the token to the SDK', async () => {
    const { capturePageview } = await import('./posthog');
    capturePageview('/invite/');
    const [name, props] = sdk.capture.mock.calls.at(-1)!;
    expect(name).toBe('$pageview');
    expect(props).toMatchObject({ $current_url: 'https://app.oraly.ai/invite/', path: '/invite/' });
    expect(JSON.stringify(props)).not.toContain('SECRET_TEST_TOKEN');
  });

  it('a manual track() event reaches the SDK unchanged, to be sanitised by before_send', async () => {
    const { track } = await import('./posthog');
    track('invite_accepted', { role: 'editor' });
    expect(sdk.capture).toHaveBeenLastCalledWith('invite_accepted', expect.objectContaining({ role: 'editor' }));
  });
});
