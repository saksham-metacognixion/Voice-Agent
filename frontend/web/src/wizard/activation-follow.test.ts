import type { ActivationView } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { ACTIVATION_FAILED_POLL_MS, ACTIVATION_POLL_MS, activationFollow, activationForCheckout, isActivationTerminal } from './activation-follow';

const AGENT = '00000000-0000-4000-8000-000000000001';

function view(over: Partial<ActivationView> = {}): ActivationView {
  return {
    activation_id: '00000000-0000-4000-8000-0000000000a1',
    agent_id: AGENT,
    status: 'publishing',
    step: 'publish',
    progress: 10,
    attempt: 1,
    max_attempts: 3,
    steps: [],
    number_id: null,
    e164: null,
    forwarding: null,
    error: null,
    created_at: '2026-10-26T12:00:05.000Z',
    updated_at: '2026-10-26T12:00:05.000Z',
    ...over,
  };
}

describe('activationForCheckout (QA-020)', () => {
  it('shows an activation created at or after the purchase, both on the server clock', () => {
    expect(activationForCheckout(view(), '2026-10-26T12:00:00.000Z')).not.toBeNull();
    expect(activationForCheckout(view({ created_at: '2026-10-26T12:00:00.000Z' }), '2026-10-26T12:00:00.000Z')).not.toBeNull();
  });

  it('hides an older activation — a failed attempt from before this checkout', () => {
    expect(activationForCheckout(view({ created_at: '2026-10-25T09:00:00.000Z', status: 'failed' }), '2026-10-26T12:00:00.000Z')).toBeNull();
  });

  it('never reads the browser clock: a client three minutes fast still sees this payment’s activation', () => {
    const realNow = Date.now;
    Date.now = () => Date.parse('2026-10-26T12:03:05.000Z');
    try {
      expect(activationForCheckout(view(), '2026-10-26T12:00:00.000Z')).not.toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it('holds while the confirm has not answered, and shows the latest when there is nothing to compare with', () => {
    expect(activationForCheckout(view(), 'pending')).toBeNull();
    expect(activationForCheckout(view({ created_at: '2020-01-01T00:00:00.000Z' }), null)).not.toBeNull();
    expect(activationForCheckout(null, null)).toBeNull();
  });
});

describe('activationFollow (QA-018)', () => {
  it('polls fast and follows the activation’s own topic while it runs', () => {
    expect(activationFollow(AGENT, view())).toEqual({ pollMs: ACTIVATION_POLL_MS, topics: [`activation:${view().activation_id}`] });
  });

  it('keeps watching after a failure, slower, with the topics that announce a new attempt', () => {
    const failed = view({ status: 'failed' });
    expect(isActivationTerminal(failed)).toBe(true);
    const follow = activationFollow(AGENT, failed);
    expect(follow.pollMs).toBe(ACTIVATION_FAILED_POLL_MS);
    expect(follow.topics).toEqual([`activation:${failed.activation_id}`, `agent:${AGENT}`, 'wallet']);
  });

  it('stops only once live', () => {
    expect(activationFollow(AGENT, view({ status: 'live' }))).toEqual({ pollMs: null, topics: null });
  });

  it('polls for the first activation with no topic to follow yet', () => {
    expect(activationFollow(AGENT, null)).toEqual({ pollMs: ACTIVATION_POLL_MS, topics: null });
  });
});
