import { routes, safeNext } from '../routes';

/**
 * The invite link someone opened before they could accept it (BUG-008).
 *
 * `?next=` carries `/invite/?token=` through sign-in, sign-up and verification in one
 * tab. This is the fallback for what a query string cannot cross: the confirmation link
 * opened in a new tab, a sign-up started from Auth0's own "Sign up" tab, or "Sign out"
 * on the join screen to switch to the invited address. Without it the invitee reached
 * `/`, the gate saw no workspace and sent them to create one — and the invite stayed
 * pending.
 *
 * Kept only while the invite page cannot show its button (signed out, or unverified),
 * read by `/` after sign-in, cleared the moment the join screen renders. It is a path,
 * validated as one on the way in and on the way out, and only ever an `/invite/` path —
 * it can send someone to the join screen and nowhere else; accepting stays a click.
 */

const KEY = 'portal:pending-invite';
/** The invite's own lifetime (`INVITE_TTL_MS`); a link older than that is dead anyway. */
const TTL_MS = 7 * 86_400_000;

/** A same-origin `/invite/?token=…` path, else null. */
export function invitePath(value: string | null | undefined): string | null {
  const path = safeNext(value, '');
  if (!path.startsWith(routes.invite)) return null;
  const token = new URL(path, 'https://portal.invalid').searchParams.get('token');
  return token ? path : null;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const pendingInvite = {
  save(path: string, now = Date.now()): void {
    const valid = invitePath(path);
    if (!valid) return;
    try {
      storage()?.setItem(KEY, JSON.stringify({ path: valid, at: now }));
    } catch {
      /* private mode or full: `?next=` still carries it in this tab */
    }
  },

  /** The saved invite path, or null when there is none, it is stale, or it does not validate. */
  peek(now = Date.now()): string | null {
    try {
      const raw = storage()?.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { path?: unknown; at?: unknown };
      const fresh = typeof parsed.at === 'number' && now - parsed.at >= 0 && now - parsed.at < TTL_MS;
      const path = fresh && typeof parsed.path === 'string' ? invitePath(parsed.path) : null;
      if (!path) storage()?.removeItem(KEY);
      return path;
    } catch {
      return null;
    }
  },

  clear(): void {
    try {
      storage()?.removeItem(KEY);
    } catch {
      /* nothing to clear */
    }
  },
};
