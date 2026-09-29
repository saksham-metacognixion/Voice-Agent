import { disposableEmailBlocklistSet } from 'disposable-email-domains-js';

/**
 * §6.2 / §17 — "Disposable email domains blocked at sign-up (open-source list). Free-mail
 * domains allowed (many SMBs use Gmail)."
 *
 * The list is `disposable-email-domains-js`, pinned to the same exact version as the
 * `customer-pre-registration` Auth0 Action (`infra/auth0/tenant.customer.yaml`), which is
 * the first guard — it refuses the sign-up before the account exists. This is the second:
 * `UsersService.upsert` refuses to create a `users` row for such an address whichever path
 * asks (the registration webhook, the login webhook, the guard's JIT provisioning), so a
 * tenant whose Action was never deployed still cannot onboard a throwaway address.
 * `disposable-email.test.ts` pins the two versions together and runs the Action itself.
 *
 * A subdomain of a listed domain is refused too (`x.mailinator.com`): several services
 * hand out unlimited subdomains and the list names only the parent.
 */
let blocklist: Set<string> | null = null;

export function isDisposableEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return isDisposableDomain(email.slice(at + 1));
}

export function isDisposableDomain(domain: string): boolean {
  blocklist ??= disposableEmailBlocklistSet();
  const labels = domain.trim().toLowerCase().replace(/\.+$/, '').split('.');
  // Every suffix of two labels or more: a.b.mailinator.com → b.mailinator.com → mailinator.com.
  for (let i = 0; i <= labels.length - 2; i += 1) {
    if (blocklist.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}
