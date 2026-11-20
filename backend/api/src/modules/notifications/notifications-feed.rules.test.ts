import { describe, expect, it } from 'vitest';
import { FEED_KINDS, feedMeta, isFeedKind, isUnread } from './notifications-feed.rules';

describe('the bell as a read over the outbox (ADR 0041)', () => {
  it('lists the §7.2 kinds and nothing that is not news to a member', () => {
    expect(FEED_KINDS).toEqual(expect.arrayContaining(['low_balance', 'message_captured', 'number_active', 'auto_topup_failed', 'member_joined']));
    expect(isFeedKind('daily_digest')).toBe(false);
    expect(isFeedKind('invite')).toBe(false);
    expect(isFeedKind('purchase_review')).toBe(false);
  });

  it('hands the bell the facts and never the email body', () => {
    const meta = feedMeta({ balance: 12.5, pct: 20, text: 'Dear owner…', html: '<p>…</p>', e164: '+14165550100', nested: { a: 1 } });
    expect(meta).toEqual({ balance: 12.5, pct: 20, e164: '+14165550100' });
    expect(feedMeta(null)).toBeNull();
    expect(feedMeta('x')).toBeNull();
    expect(feedMeta({ text: 'only the body' })).toBeNull();
  });

  it('counts a row unread until the bell was opened after it', () => {
    const at = new Date('2026-11-16T10:00:00Z');
    expect(isUnread(at, null)).toBe(true);
    expect(isUnread(at, new Date('2026-11-16T09:59:59Z'))).toBe(true);
    expect(isUnread(at, at)).toBe(false);
    expect(isUnread(at, new Date('2026-11-16T10:00:01Z'))).toBe(false);
  });
});
