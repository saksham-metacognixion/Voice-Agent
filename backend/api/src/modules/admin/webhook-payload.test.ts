import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDACTED, redactWebhookPayload } from './webhook-payload';

/** The body the receiver stores for a real platform event (test/fixtures/retell). */
function storedBody(file: string): Record<string, unknown> {
  const fixture = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/retell', file), 'utf8')) as { body: Record<string, unknown> };
  return fixture.body;
}

describe('redactWebhookPayload (QA-033)', () => {
  it('blanks the recording links, the call log, the transcript in every shape and the summary of a real call_analyzed', () => {
    const body = storedBody('call_analyzed-inbound.json');
    const call = body.call as Record<string, unknown>;
    // The fixture is the sensitive kind: a transcript and the recording links.
    expect(typeof call.transcript).toBe('string');
    const { payload, redacted } = redactWebhookPayload(body);
    const text = JSON.stringify(payload);
    expect(text).not.toContain((call.transcript as string).slice(0, 40));
    expect(text).not.toContain('Maple Dental');
    expect(redacted).toEqual(
      expect.arrayContaining([
        'call.transcript',
        'call.transcript_object',
        'call.transcript_with_tool_calls',
        'call.recording_url',
        'call.recording_multi_channel_url',
        'call.public_log_url',
        'call.call_analysis.call_summary',
      ]),
    );
    const out = (payload as { call: Record<string, unknown> }).call;
    expect(out.recording_url).toBe(REDACTED);
    expect(out.transcript_object).toBe(REDACTED);
  });

  it('keeps what an operator reads a payload for', () => {
    const body = storedBody('call_ended-inbound-user_hangup.json');
    const call = body.call as Record<string, unknown>;
    const out = (redactWebhookPayload(body).payload as { event: string; call: Record<string, unknown> });
    expect(out.event).toBe(body.event);
    for (const key of ['call_id', 'agent_id', 'call_status', 'start_timestamp', 'end_timestamp', 'disconnection_reason', 'from_number', 'to_number', 'metadata', 'call_cost', 'latency']) {
      if (key in call) expect(out.call[key]).toEqual(call[key]);
    }
  });

  it('matches field names at any depth and in any case or separator, and leaves empty values and operational fields alone', () => {
    const { payload, redacted } = redactWebhookPayload({
      data: [{ nested: { scrubbedRecordingMultiChannelUrl: 'https://cdn/x.wav', 'Transcript-Object': [{ content: 'hi' }] } }],
      recording_url: null,
      transcript: '',
      call_id: 'call_1',
      recordings_count: 0,
      recording_enabled: true,
      recording_status: 'ready',
    });
    expect(payload).toEqual({
      data: [{ nested: { scrubbedRecordingMultiChannelUrl: REDACTED, 'Transcript-Object': REDACTED } }],
      recording_url: null,
      transcript: '',
      call_id: 'call_1',
      recordings_count: 0,
      recording_enabled: true,
      recording_status: 'ready',
    });
    expect(redacted).toEqual(['data[0].nested.scrubbedRecordingMultiChannelUrl', 'data[0].nested.Transcript-Object']);
  });

  it('leaves a Stripe event untouched and reports nothing', () => {
    const stripe = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', amount_total: 4900, metadata: { workspace_id: 'w' } } } };
    expect(redactWebhookPayload(stripe)).toEqual({ payload: stripe, redacted: [] });
  });

  it('does not mutate the stored body', () => {
    const body = { call: { recording_url: 'https://cdn/x.wav' } };
    redactWebhookPayload(body);
    expect(body.call.recording_url).toBe('https://cdn/x.wav');
  });
});
