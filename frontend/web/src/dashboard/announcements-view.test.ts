import type { AnnouncementResponse } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { DISMISSED_KEY, announcementVariant, readDismissed, visibleAnnouncements, writeDismissed } from './announcements-view';

const a = (id: string, over: Partial<AnnouncementResponse> = {}): AnnouncementResponse => ({
  id,
  severity: 'info',
  body: 'Hello',
  starts_at: null,
  ends_at: null,
  dismissible: true,
  created_at: '2026-11-16T10:00:00.000Z',
  ...over,
});

describe('announcements on D1 (ADR 0041)', () => {
  it('hides a dismissible banner this browser hid, never one that is not dismissible', () => {
    const items = [a('1'), a('2', { dismissible: false }), a('3')];
    expect(visibleAnnouncements(items, new Set(['1', '2'])).map((x) => x.id)).toEqual(['2', '3']);
    expect(visibleAnnouncements([], new Set(['1']))).toEqual([]);
  });
  it('maps severity to the alert variant', () => {
    expect(announcementVariant('info')).toBe('info');
    expect(announcementVariant('warning')).toBe('warning');
    expect(announcementVariant('danger')).toBe('danger');
  });
  it('reads, prunes and writes the per-browser dismissals, and survives a broken store', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    writeDismissed(storage, new Set(['1', '9']));
    expect(readDismissed(storage, ['1', '2'])).toEqual(new Set(['1']));
    store.set(DISMISSED_KEY, '{not json');
    expect(readDismissed(storage, ['1'])).toEqual(new Set());
    store.set(DISMISSED_KEY, JSON.stringify([1, 'x']));
    expect(readDismissed(storage, ['x'])).toEqual(new Set(['x']));
    expect(readDismissed(null, ['1'])).toEqual(new Set());
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readDismissed(throwing, ['1'])).toEqual(new Set());
    expect(() => writeDismissed(throwing, new Set(['1']))).not.toThrow();
  });
});
