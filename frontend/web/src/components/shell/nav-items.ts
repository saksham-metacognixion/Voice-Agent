import { BookOpen, HelpCircle, Home, Phone, PhoneCall, Settings, Wallet, type LucideIcon } from 'lucide-react';
import { routes } from '@/src/routes';

export interface NavItem {
  key: 'home' | 'calls' | 'agents' | 'numbers' | 'wallet' | 'settings' | 'help';
  href: string;
  icon: LucideIcon;
}

/** §7.2 left nav, in two groups like the reference: what you build, what you operate. */
export const NAV_GROUPS: Array<{ key: 'build' | 'operate' | 'account'; items: NavItem[] }> = [
  {
    key: 'build',
    items: [
      { key: 'home', href: routes.app.home, icon: Home },
      { key: 'agents', href: routes.app.agents, icon: BookOpen },
      { key: 'numbers', href: routes.app.numbers, icon: Phone },
    ],
  },
  {
    key: 'operate',
    items: [
      { key: 'calls', href: routes.app.calls, icon: PhoneCall },
      { key: 'wallet', href: routes.app.wallet, icon: Wallet },
    ],
  },
  {
    key: 'account',
    items: [
      { key: 'settings', href: routes.app.settings, icon: Settings },
      { key: 'help', href: routes.app.help, icon: HelpCircle },
    ],
  },
];
