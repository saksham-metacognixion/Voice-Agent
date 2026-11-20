import { describe, expect, it } from 'vitest';
import { liveChecklist } from './live-checklist';

const forwarding = (status: 'waiting_for_customer' | 'ready' | 'failed', test: 'landed' | 'not_landed' | null = null) => ({
  forwarding: { from: '+14165550100', status, carrier: null, mode: null, test: test ? { status: test, started_at: '2026-11-06T00:00:00Z', finished_at: null, caller_id: null } : null },
});

describe('liveChecklist', () => {
  it('lists the spec’s three next steps for a bought number, all open before anything is done', () => {
    expect(liveChecklist({ number: { forwarding: null }, members: [{ id: 'me' }], notifications: { new_message: 'instant' }, widget: { enabled: false } })).toEqual([
      { key: 'invite_team', done: false },
      { key: 'daily_digest', done: false },
      { key: 'website_widget', done: false },
    ]);
  });

  it('ticks each step from the rows the API holds', () => {
    expect(liveChecklist({ number: { forwarding: null }, members: [{ id: 'me' }, { id: 'them' }], notifications: { new_message: 'daily' }, widget: { enabled: true } }).map((i) => i.done)).toEqual([true, true, true]);
  });

  it('adds forwarding for an Option B number: confirmed or a test that landed counts', () => {
    expect(liveChecklist({ number: forwarding('waiting_for_customer'), members: undefined, notifications: undefined, widget: undefined })[0]).toEqual({ key: 'forwarding', done: false });
    expect(liveChecklist({ number: forwarding('ready'), members: undefined, notifications: undefined, widget: undefined })[0]).toEqual({ key: 'forwarding', done: true });
    expect(liveChecklist({ number: forwarding('waiting_for_customer', 'landed'), members: undefined, notifications: undefined, widget: undefined })[0]).toEqual({ key: 'forwarding', done: true });
  });

  it('reads a fact not loaded yet as not done', () => {
    expect(liveChecklist({ number: undefined, members: undefined, notifications: undefined, widget: undefined }).every((i) => !i.done)).toBe(true);
  });
});
