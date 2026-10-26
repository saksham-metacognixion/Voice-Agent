import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invitePath, pendingInvite } from './pending-invite';

/*
 * BUG-008: an invitee who opened the link signed out came back from sign-up or the
 * confirmation email to "set up a workspace". The remembered link is the fallback for
 * the steps `?next=` cannot cross — and it may only ever point at the join screen.
 */

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: memoryStorage() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('invitePath', () => {
  it('accepts the join screen with its token', () => {
    expect(invitePath('/invite/?token=abc_DEF-123')).toBe('/invite/?token=abc_DEF-123');
  });

  it.each([
    ['https://evil.example/invite/?token=x'],
    ['//evil.example/invite/?token=x'],
    ['/\\evil.example/invite/?token=x'],
    ['/app/?token=x'],
    ['/invite/'],
    ['/invite/?token='],
    ['/login/?next=/invite/?token=x'],
    [null],
  ])('refuses %s', (value) => {
    expect(invitePath(value)).toBeNull();
  });
});

describe('pendingInvite', () => {
  const now = Date.UTC(2026, 9, 26);

  it('remembers an invite until it is cleared', () => {
    pendingInvite.save('/invite/?token=abc', now);
    expect(pendingInvite.peek(now + 60_000)).toBe('/invite/?token=abc');
    pendingInvite.clear();
    expect(pendingInvite.peek(now + 60_000)).toBeNull();
  });

  it('never stores anything but an invite path', () => {
    pendingInvite.save('https://evil.example/invite/?token=abc', now);
    pendingInvite.save('/app/settings/', now);
    expect(pendingInvite.peek(now)).toBeNull();
  });

  it('forgets an invite older than the invite itself lives, and anything tampered with', () => {
    pendingInvite.save('/invite/?token=abc', now);
    expect(pendingInvite.peek(now + 8 * 86_400_000)).toBeNull();

    window.localStorage.setItem('portal:pending-invite', JSON.stringify({ path: '//evil.example/invite/?token=x', at: now }));
    expect(pendingInvite.peek(now)).toBeNull();
    window.localStorage.setItem('portal:pending-invite', '{not json');
    expect(pendingInvite.peek(now)).toBeNull();
  });

  it('does not throw without storage (private mode, prerender)', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('denied');
      },
    });
    expect(() => pendingInvite.save('/invite/?token=abc', now)).not.toThrow();
    expect(pendingInvite.peek(now)).toBeNull();
    expect(() => pendingInvite.clear()).not.toThrow();
  });
});
