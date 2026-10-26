import type { CaptureResult } from 'posthog-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sanitizeCapture, sanitizeProperties, sanitizeUrl } from './sanitize';

const SECRETS = ['SECRET_TEST_TOKEN', 'AUTH_CODE_123', 'STATE_456', 'cs_test_a1B2c3', 'IMP_KEY_789'];

beforeAll(() => {
  vi.stubGlobal('window', { location: { origin: 'https://app.oraly.ai' } });
});
afterAll(() => {
  vi.unstubAllGlobals();
});

function leaks(value: unknown): string[] {
  const text = JSON.stringify(value);
  return SECRETS.filter((s) => text.includes(s));
}

function event(name: string, properties: Record<string, unknown>, extra: Partial<CaptureResult> = {}): CaptureResult {
  return { uuid: '00000000-0000-4000-8000-000000000000', event: name, properties, ...extra };
}

describe('sanitizeUrl (QA-008)', () => {
  it.each([
    ['https://app.oraly.ai/invite/?token=SECRET_TEST_TOKEN', 'https://app.oraly.ai/invite/'],
    ['https://app.oraly.ai/?code=AUTH_CODE_123&state=STATE_456', 'https://app.oraly.ai/'],
    ['https://app.oraly.ai/onboarding/activate/?session_id=cs_test_a1B2c3', 'https://app.oraly.ai/onboarding/activate/'],
    ['https://app.oraly.ai/impersonate/#session=s1&key=IMP_KEY_789', 'https://app.oraly.ai/impersonate/'],
    ['https://app.oraly.ai/login/?next=%2Finvite%2F%3Ftoken%3DSECRET_TEST_TOKEN', 'https://app.oraly.ai/login/'],
    ['/invite/?token=SECRET_TEST_TOKEN', '/invite/'],
    ['https://tenant.auth0.com/u/login?state=STATE_456', 'https://tenant.auth0.com/'],
    ['https://checkout.stripe.com/c/pay/cs_test_a1B2c3#fidkdWxOYHwnPyd1blpxYHZxWjA0', 'https://checkout.stripe.com/'],
    ['//evil.example/x?token=SECRET_TEST_TOKEN', 'https://evil.example/'],
  ])('%s → %s', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });

  it('keeps the allow-listed, non-sensitive `tab` parameter and nothing else', () => {
    expect(sanitizeUrl('https://app.oraly.ai/app/agents/detail/?id=a1&tab=prompt')).toBe('https://app.oraly.ai/app/agents/detail/?tab=prompt');
    expect(sanitizeUrl('https://app.oraly.ai/app/settings/?tab=team#x')).toBe('https://app.oraly.ai/app/settings/?tab=team');
  });

  it('leaves ordinary values alone', () => {
    expect(sanitizeUrl('https://app.oraly.ai/app/calls/')).toBe('https://app.oraly.ai/app/calls/');
    expect(sanitizeUrl('$direct')).toBe('$direct');
    expect(sanitizeUrl('app.oraly.ai')).toBe('app.oraly.ai');
    expect(sanitizeUrl('')).toBe('');
  });
});

describe('sanitizeCapture — the before_send hook (QA-008)', () => {
  it('strips $current_url, $referrer and the session/entry URLs on a page view', () => {
    const out = sanitizeCapture(
      event('$pageview', {
        token: 'phc_project_key',
        $current_url: 'https://app.oraly.ai/invite/?token=SECRET_TEST_TOKEN',
        $referrer: 'https://tenant.auth0.com/u/login?state=STATE_456',
        $referring_domain: 'tenant.auth0.com',
        $session_entry_url: 'https://app.oraly.ai/?code=AUTH_CODE_123&state=STATE_456',
        $session_entry_referrer: '$direct',
        $pathname: '/invite/',
        $host: 'app.oraly.ai',
        path: '/invite/',
        workspace_id: 'ws_1',
      }),
    )!;
    expect(leaks(out)).toEqual([]);
    expect(out.properties.$current_url).toBe('https://app.oraly.ai/invite/');
    expect(out.properties.$referrer).toBe('https://tenant.auth0.com/');
    expect(out.properties.$session_entry_referrer).toBe('$direct');
    // Ordinary page-view analytics still work: path, host, workspace and the project key survive.
    expect(out.properties).toMatchObject({ token: 'phc_project_key', $pathname: '/invite/', $host: 'app.oraly.ai', path: '/invite/', workspace_id: 'ws_1', $referring_domain: 'tenant.auth0.com' });
    expect(out.event).toBe('$pageview');
  });

  it('strips the page-leave event the SDK captures on its own', () => {
    const out = sanitizeCapture(
      event('$pageleave', {
        $current_url: 'https://app.oraly.ai/onboarding/activate/?session_id=cs_test_a1B2c3',
        $prev_pageview_pathname: '/onboarding/activate/',
        $prev_pageview_duration: 12,
      }),
    )!;
    expect(leaks(out)).toEqual([]);
    expect(out.properties.$prev_pageview_duration).toBe(12);
  });

  it('strips person properties ($set / $set_once) and nested bags', () => {
    const out = sanitizeCapture(
      event(
        '$web_vitals',
        { $web_vitals_LCP_event: { $current_url: 'https://app.oraly.ai/?code=AUTH_CODE_123&state=STATE_456', value: 1200 } },
        {
          $set: { $current_url: 'https://app.oraly.ai/invite/?token=SECRET_TEST_TOKEN' },
          $set_once: { $initial_current_url: 'https://app.oraly.ai/?code=AUTH_CODE_123', $initial_referrer: 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3#frag' },
        },
      ),
    )!;
    expect(leaks(out)).toEqual([]);
    expect((out.properties.$web_vitals_LCP_event as { value: number }).value).toBe(1200);
    expect(out.$set_once?.$initial_referrer).toBe('https://checkout.stripe.com/');
  });

  it('covers manual events: credential-named properties are dropped, URL-shaped values stripped', () => {
    const out = sanitizeCapture(
      event('checkout_returned', {
        agent_id: 'agent_1',
        session_id: 'cs_test_a1B2c3',
        code: 'AUTH_CODE_123',
        state: 'STATE_456',
        from: '/onboarding/activate/?session_id=cs_test_a1B2c3',
        step: 'activate',
      }),
    )!;
    expect(out.properties).toEqual({ agent_id: 'agent_1', from: '/onboarding/activate/', step: 'activate' });
  });

  it('passes a dropped event through', () => {
    expect(sanitizeCapture(null)).toBeNull();
  });

  it('does not mutate what it was given', () => {
    const props = { $current_url: 'https://app.oraly.ai/invite/?token=SECRET_TEST_TOKEN' };
    sanitizeProperties(props);
    expect(props.$current_url).toContain('SECRET_TEST_TOKEN');
  });
});
