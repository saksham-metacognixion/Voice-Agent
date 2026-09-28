/**
 * The admin sitemap (admin spec §3) as constants. Every path ends with a slash to match
 * `trailingSlash: true` in the export; detail pages take `?id=` because a static export
 * cannot serve an arbitrary segment (the portal does the same for `/app/agents/detail/`).
 */
export const routes = {
  root: '/',
  login: '/login/',
  overview: '/overview/',
  customers: '/customers/',
  customerDetail: '/customers/detail/',
  users: '/users/',
  userDetail: '/users/detail/',
  support: '/support/',
  pricing: '/pricing/',
  agentStack: '/agent-stack/',
  telephony: '/telephony/',
  calls: '/calls/',
  billing: '/billing/',
  comms: '/comms/',
  trust: '/trust/',
  system: '/system/',
  staff: '/staff/',
  audit: '/audit/',
} as const;

/** SA2 Customer 360 tabs, in the order the spec lists them. */
export const CUSTOMER_TABS = ['overview', 'members', 'wallet', 'purchases', 'agents', 'numbers', 'calls', 'jobs', 'webhooks', 'audit'] as const;
export type CustomerTab = (typeof CUSTOMER_TABS)[number];

export function customerPath(id: string, tab: CustomerTab = 'overview'): string {
  const query = new URLSearchParams({ id });
  if (tab !== 'overview') query.set('tab', tab);
  return `${routes.customerDetail}?${query.toString()}`;
}

export function userPath(id: string): string {
  return `${routes.userDetail}?id=${encodeURIComponent(id)}`;
}

export const PRICING_TABS = ['draft', 'preview', 'versions', 'costs'] as const;
export type PricingTab = (typeof PRICING_TABS)[number];

export const TELEPHONY_TABS = ['numbers', 'agents'] as const;
export type TelephonyTab = (typeof TELEPHONY_TABS)[number];

export function telephonyPath(tab: TelephonyTab, id?: string): string {
  const query = new URLSearchParams();
  if (tab !== 'numbers') query.set('tab', tab);
  if (id) query.set('id', id);
  const q = query.toString();
  return `${routes.telephony}${q ? `?${q}` : ''}`;
}

export const SYSTEM_TABS = ['health', 'jobs', 'webhooks', 'flags'] as const;
export type SystemTab = (typeof SYSTEM_TABS)[number];

export function systemPath(tab: SystemTab = 'health', id?: string): string {
  const query = new URLSearchParams();
  if (tab !== 'health') query.set('tab', tab);
  if (id) query.set('id', id);
  const q = query.toString();
  return `${routes.system}${q ? `?${q}` : ''}`;
}

export function callsPath(opts: { tenant_id?: string; id?: string } = {}): string {
  const query = new URLSearchParams();
  if (opts.tenant_id) query.set('tenant_id', opts.tenant_id);
  if (opts.id) query.set('id', opts.id);
  const q = query.toString();
  return `${routes.calls}${q ? `?${q}` : ''}`;
}

export function auditPath(opts: { tenant_id?: string; target_id?: string; id?: string } = {}): string {
  const query = new URLSearchParams();
  if (opts.tenant_id) query.set('tenant_id', opts.tenant_id);
  if (opts.target_id) query.set('target_id', opts.target_id);
  if (opts.id) query.set('id', opts.id);
  const q = query.toString();
  return `${routes.audit}${q ? `?${q}` : ''}`;
}

export function withNext(path: string, next: string | null | undefined): string {
  if (!next || next === '/' || !next.startsWith('/')) return path;
  return `${path}?next=${encodeURIComponent(next)}`;
}

/** Only ever send people to a path on this origin; `//evil` and `https://` are refused. */
export function safeNext(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('://')) return fallback;
  return value;
}
