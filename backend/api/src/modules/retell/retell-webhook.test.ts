import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callIdOf, channelOf, directionOf, parseRetellWebhook } from './retell-webhook';

/*
 * The classifier that decides what a stored Retell webhook is. Checked against every D2
 * fixture, so a payload shape Retell changes fails here rather than in the metering job.
 */

const FIXTURES = path.resolve(__dirname, '../../../test/fixtures/retell');

function fixture(file: string): { body: unknown; headers?: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as {
    body: unknown;
    headers?: Record<string, string>;
  };
}

function body(file: string): unknown {
  return fixture(file).body;
}

/**
 * A raw capture the platform delivered, as opposed to one a local tool posted to the API
 * itself: the D11 QA seed, Postman and the test harness all sign and post synthetic
 * lifecycle events at `localhost`, and `FixtureWriter` records those too. They prove
 * nothing about Retell's payload shape, and the seed's `qa11seed_*` call ids failed the
 * platform-id assertion below for three days (28 Sep). Curated fixtures carry no
 * timestamp and are always read.
 */
function deliveredByPlatform(file: string): boolean {
  if (!/-20\d\d-\d\d-\d\dT/.test(file)) return true;
  const host = fixture(file).headers?.host ?? '';
  return !/^(localhost|127\.0\.0\.1)(:|$)/.test(host);
}

describe('parseRetellWebhook against the D2 fixtures', () => {
  const lifecycleFiles = readdirSync(FIXTURES)
    .filter((f) => /^call_(started|ended|analyzed)/.test(f))
    .filter(deliveredByPlatform);

  it('reads every captured lifecycle payload', () => {
    expect(lifecycleFiles.length).toBeGreaterThan(5);
    for (const file of lifecycleFiles) {
      const parsed = parseRetellWebhook(body(file));
      expect(parsed.kind, file).toBe('lifecycle');
      if (parsed.kind !== 'lifecycle') continue;
      expect(parsed.event.call.call_id, file).toMatch(/^call_/);
      expect(['call_started', 'call_ended', 'call_analyzed']).toContain(parsed.event.event);
    }
  });

  it('keeps the fields metering depends on', () => {
    const parsed = parseRetellWebhook(body('call_ended-inbound-user_hangup.json'));
    expect(parsed.kind).toBe('lifecycle');
    if (parsed.kind !== 'lifecycle') return;
    expect(parsed.event.call).toMatchObject({
      start_timestamp: 1789450193999,
      end_timestamp: 1789450269548,
      disconnection_reason: 'user_hangup',
      call_status: 'ended',
    });
    expect(parsed.event.call.call_cost?.combined_cost).toBeCloseTo(17.0266692, 6);
  });

  it('classifies transfer_* and unknown types as unsupported, with the call id', () => {
    const parsed = parseRetellWebhook({ event: 'transfer_started', call: { call_id: 'call_x' } });
    expect(parsed).toEqual({ kind: 'unsupported', eventType: 'transfer_started', callId: 'call_x' });
    expect(parseRetellWebhook({ event: 'something_new_2027', call_id: 'call_y' })).toMatchObject({ kind: 'unsupported', callId: 'call_y' });
  });

  it('refuses a malformed payload with a reason instead of throwing', () => {
    expect(parseRetellWebhook(null)).toMatchObject({ kind: 'malformed' });
    expect(parseRetellWebhook('{}')).toMatchObject({ kind: 'malformed' });
    expect(parseRetellWebhook({})).toMatchObject({ kind: 'malformed', reason: 'missing event type' });
    expect(parseRetellWebhook({ event: 'call_ended' })).toMatchObject({ kind: 'malformed' });
    // A lifecycle event with no call_id is the case that would otherwise bill a nameless call.
    const noId = parseRetellWebhook({ event: 'call_ended', call: { start_timestamp: 1, end_timestamp: 2 } });
    expect(noId).toMatchObject({ kind: 'malformed' });
    if (noId.kind === 'malformed') expect(noId.reason).toContain('call_id');
  });

  it('passes unknown fields through rather than stripping them', () => {
    const parsed = parseRetellWebhook({ event: 'call_started', call: { call_id: 'call_z', something_new: 42 } });
    expect(parsed.kind).toBe('lifecycle');
    if (parsed.kind === 'lifecycle') expect((parsed.event.call as Record<string, unknown>).something_new).toBe(42);
  });
});

describe('callIdOf', () => {
  it('finds the id wherever Retell puts it', () => {
    expect(callIdOf(body('call_inbound-allow.json'))).toBe('call_016c7be0a88e114a05437321e03');
    expect(callIdOf(body('call_started-web.json'))).toBe('call_1cb31dd3e5300aafeded570879c');
    expect(callIdOf({ call_id: 'call_top' })).toBe('call_top');
    expect(callIdOf({ call: {} })).toBeNull();
    expect(callIdOf(null)).toBeNull();
  });
});

describe('channel and direction', () => {
  it('maps Retell call types onto §15 columns, defaulting to phone/inbound', () => {
    expect(channelOf('web_call')).toBe('web');
    expect(channelOf('phone_call')).toBe('phone');
    expect(channelOf(undefined)).toBe('phone');
    expect(directionOf('outbound')).toBe('outbound');
    expect(directionOf(null)).toBe('inbound');
  });
});
