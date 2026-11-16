import type { NotificationItemResponse } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { knownNotifications, notificationHref, relativeAge, unreadBadge } from './notifications-view';

const item = (kind: NotificationItemResponse['kind'], meta: Record<string, unknown> | null = null): NotificationItemResponse => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind,
  meta,
  created_at: '2026-11-16T10:00:00.000Z',
  unread: true,
});

describe('notificationHref (§7.2 bell)', () => {
  it('sends each kind to the thing it is about', () => {
    expect(notificationHref(item('low_balance'))).toBe('/app/wallet/');
    expect(notificationHref(item('auto_topup_failed'))).toBe('/app/wallet/');
    expect(notificationHref(item('rental_overdue'))).toBe('/app/wallet/');
    expect(notificationHref(item('message_captured', { call_id: 'call_abc' }))).toBe('/app/calls/?call=call_abc');
    expect(notificationHref(item('message_captured'))).toBe('/app/calls/');
    expect(notificationHref(item('number_active'))).toBe('/app/numbers/');
    expect(notificationHref(item('number_released'))).toBe('/app/numbers/');
    expect(notificationHref(item('member_joined'))).toBe('/app/settings/?tab=team');
  });
  it('drops a kind this build does not know', () => {
    const odd = { ...item('low_balance'), kind: 'surprise' as NotificationItemResponse['kind'] };
    expect(knownNotifications([item('member_joined'), odd]).map((i) => i.kind)).toEqual(['member_joined']);
  });
});

describe('relativeAge and unreadBadge', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  it('reads minutes, hours and days in the given language', () => {
    expect(relativeAge('2026-11-16T11:58:30Z', now, 'en')).toBe('1 minute ago');
    expect(relativeAge('2026-11-16T09:00:00Z', now, 'en')).toBe('3 hours ago');
    expect(relativeAge('2026-11-15T11:00:00Z', now, 'en')).toBe('yesterday');
    expect(relativeAge('2026-11-01T11:00:00Z', now, 'en')).toBe('Nov 1');
    expect(relativeAge('2026-11-16T09:00:00Z', now, 'fr-CA')).toBe('il y a 3 heures');
    expect(relativeAge('not a date', now, 'en')).toBe('');
  });
  it('caps the badge at 9+', () => {
    expect(unreadBadge(0)).toBeNull();
    expect(unreadBadge(3)).toBe('3');
    expect(unreadBadge(12)).toBe('9+');
    expect(unreadBadge(Number.NaN)).toBeNull();
  });
});
