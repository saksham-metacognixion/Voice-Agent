import { describe, expect, it } from 'vitest';
import { activeAnnouncements, audienceIncludes, isLive, severityOf, type AnnouncementRow } from './announcements.rules';

const facts = { tenantId: '11111111-1111-4111-8111-111111111111', planTier: 'growth', country: 'CA' };
const now = new Date('2026-11-16T12:00:00Z');
const row = (over: Partial<AnnouncementRow> = {}): AnnouncementRow => ({
  id: '22222222-2222-4222-8222-222222222222',
  type: 'banner',
  body: 'Maintenance tonight',
  severity: 'warning',
  audienceJson: null,
  startsAt: null,
  endsAt: null,
  dismissible: true,
  createdAt: new Date('2026-11-15T00:00:00Z'),
  ...over,
});

describe('announcement audience (SA10, ADR 0041)', () => {
  it('null, {} and {all: true} reach everyone', () => {
    expect(audienceIncludes(null, facts)).toBe(true);
    expect(audienceIncludes({}, facts)).toBe(true);
    expect(audienceIncludes({ all: true }, facts)).toBe(true);
  });
  it('a list narrows to the workspace that matches it, case-insensitively', () => {
    expect(audienceIncludes({ plans: ['growth', 'scale'] }, facts)).toBe(true);
    expect(audienceIncludes({ plans: ['starter'] }, facts)).toBe(false);
    expect(audienceIncludes({ countries: ['ca'] }, facts)).toBe(true);
    expect(audienceIncludes({ countries: ['US'] }, facts)).toBe(false);
    expect(audienceIncludes({ tenant_ids: [facts.tenantId] }, facts)).toBe(true);
    expect(audienceIncludes({ tenant_ids: ['33333333-3333-4333-8333-333333333333'] }, facts)).toBe(false);
  });
  it('every list present must match', () => {
    expect(audienceIncludes({ plans: ['growth'], countries: ['US'] }, facts)).toBe(false);
    expect(audienceIncludes({ plans: ['growth'], countries: ['CA'] }, facts)).toBe(true);
  });
  it('an unreadable audience reaches nobody', () => {
    expect(audienceIncludes('everyone', facts)).toBe(false);
    expect(audienceIncludes({ plans: 'growth' }, facts)).toBe(false);
    expect(audienceIncludes({ segment: 'x' }, facts)).toBe(false);
    expect(audienceIncludes([], facts)).toBe(false);
  });
});

describe('announcement window', () => {
  it('is live from its start to its end, and only as a banner', () => {
    expect(isLive(row(), now)).toBe(true);
    expect(isLive(row({ startsAt: new Date('2026-11-17T00:00:00Z') }), now)).toBe(false);
    expect(isLive(row({ endsAt: new Date('2026-11-16T12:00:00Z') }), now)).toBe(false);
    expect(isLive(row({ endsAt: new Date('2026-11-16T12:00:01Z') }), now)).toBe(true);
    expect(isLive(row({ type: 'email' }), now)).toBe(false);
  });
  it('maps an unknown severity to info and answers newest first', () => {
    expect(severityOf('critical')).toBe('info');
    expect(severityOf('danger')).toBe('danger');
    const out = activeAnnouncements([row({ id: '44444444-4444-4444-8444-444444444444', createdAt: new Date('2026-11-14T00:00:00Z'), severity: 'odd' }), row(), row({ type: 'email' })], facts, now);
    expect(out.map((a) => a.id)).toEqual(['22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444']);
    expect(out[1]!.severity).toBe('info');
    expect(out[0]).toMatchObject({ body: 'Maintenance tonight', dismissible: true, starts_at: null, ends_at: null });
  });
});
