import {
  Activity, BarChart3, Building2, ClipboardList, CreditCard, LifeBuoy, Megaphone, Phone, PhoneCall, Server, ShieldCheck, Tag, Users, UsersRound, type LucideIcon,
} from 'lucide-react';
import { routes } from '@/src/routes';

export interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** Not built in D12: the page shows the P2 placeholder. */
  p2?: boolean;
}

/** Admin spec §3 — the fourteen sections, in the spec's order. */
export const NAV_ITEMS: NavItem[] = [
  { key: 'overview', label: 'Overview', href: routes.overview, icon: BarChart3 },
  { key: 'customers', label: 'Customers', href: routes.customers, icon: Building2 },
  { key: 'users', label: 'Users', href: routes.users, icon: Users },
  { key: 'support', label: 'Support', href: routes.support, icon: LifeBuoy },
  { key: 'pricing', label: 'Pricing', href: routes.pricing, icon: Tag },
  { key: 'agent-stack', label: 'Agent stack', href: routes.agentStack, icon: Activity, p2: true },
  { key: 'telephony', label: 'Telephony', href: routes.telephony, icon: Phone },
  { key: 'calls', label: 'Calls', href: routes.calls, icon: PhoneCall },
  { key: 'billing', label: 'Billing', href: routes.billing, icon: CreditCard },
  { key: 'comms', label: 'Comms', href: routes.comms, icon: Megaphone, p2: true },
  { key: 'trust', label: 'Trust', href: routes.trust, icon: ShieldCheck, p2: true },
  { key: 'system', label: 'System', href: routes.system, icon: Server },
  { key: 'staff', label: 'Staff', href: routes.staff, icon: UsersRound },
  { key: 'audit', label: 'Audit', href: routes.audit, icon: ClipboardList },
];

export function isNavActive(item: NavItem, pathname: string): boolean {
  return pathname.startsWith(item.href);
}

export function sectionFor(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => isNavActive(i, pathname));
}
