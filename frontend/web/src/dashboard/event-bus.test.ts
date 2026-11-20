import type { SseEvent } from '@portal/schemas';
import { describe, expect, it, vi } from 'vitest';
import { createEventBus } from './event-bus';

const frame = (topic: string, type = 'x'): SseEvent => ({ id: `${topic}-${type}`, topic: topic as SseEvent['topic'], type, ts: '2026-10-26T12:00:00.000Z', data: {} });

describe('createEventBus (one /app stream, many listeners — ADR 0019 §1)', () => {
  it('hands a listener only the topics it asked for', () => {
    const bus = createEventBus();
    const agent = vi.fn();
    const all = vi.fn();
    bus.subscribe(['agent:a1'], agent);
    bus.subscribe(undefined, all);
    bus.emit(frame('agent:a1', 'generated'));
    bus.emit(frame('agent:b2', 'generated'));
    bus.emit(frame('wallet'));
    expect(agent).toHaveBeenCalledTimes(1);
    expect(agent.mock.calls[0]![0].topic).toBe('agent:a1');
    expect(all).toHaveBeenCalledTimes(3);
  });

  it('stops delivering after the unsubscribe', () => {
    const bus = createEventBus();
    const listener = vi.fn();
    const off = bus.subscribe(['call:c1'], listener);
    bus.emit(frame('call:c1', 'ended'));
    off();
    bus.emit(frame('call:c1', 'analyzed'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering to the others when one listener throws', () => {
    const bus = createEventBus();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const after = vi.fn();
    bus.subscribe(undefined, () => {
      throw new Error('boom');
    });
    bus.subscribe(undefined, after);
    bus.emit(frame('wallet'));
    expect(after).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
