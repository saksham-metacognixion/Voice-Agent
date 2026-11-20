import { impersonationContext, type ImpersonationContext } from '@portal/schemas';
import { z } from 'zod';

/**
 * Admin §7.4 "View as" on the portal side (D12). A staff member opens
 * `/impersonate/#session=&key=`; the page stores the credential here and sends them
 * to `/app`. From then on `AuthProvider` reports an authenticated session whose token
 * is the key, the API pins every request to the impersonated workspace and refuses
 * every write, and the shell shows the banner from `GET /impersonation`.
 *
 * sessionStorage, not localStorage: the view dies with the tab, which is the shortest
 * lifetime the browser offers and the one a staff member expects. Nothing here is a
 * secret worth more than the hour the key is valid for.
 */
const KEY = 'portal:impersonation';

const stored = z.object({
  session: z.string().uuid(),
  key: z.string().min(20),
  /** ISO; the key's own expiry, so a stale tab does not keep asking. */
  expires_at: z.string(),
});
export type StoredImpersonation = z.infer<typeof stored>;

export const impersonationStore = {
  get(): StoredImpersonation | null {
    try {
      if (typeof window === 'undefined') return null;
      const raw = window.sessionStorage.getItem(KEY);
      if (!raw) return null;
      const parsed = stored.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      if (new Date(parsed.data.expires_at).getTime() <= Date.now()) {
        window.sessionStorage.removeItem(KEY);
        return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  },
  set(value: StoredImpersonation): void {
    try {
      if (typeof window !== 'undefined') window.sessionStorage.setItem(KEY, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
  clear(): void {
    try {
      if (typeof window !== 'undefined') window.sessionStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};

/** The bearer the API minted; every request under view-as carries it instead of an Auth0 token. */
export function isImpersonationKey(token: string | null | undefined): boolean {
  return Boolean(token?.startsWith('imp_'));
}

export { impersonationContext };
export type { ImpersonationContext };
