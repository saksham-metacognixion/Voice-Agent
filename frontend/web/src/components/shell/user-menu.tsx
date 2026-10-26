'use client';

import {
  Avatar, AvatarFallback, AvatarImage, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuTrigger, ThemeSegment, initials,
} from '@portal/ui';
import { LogOut, Settings, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/src/auth/auth-provider';
import { routes } from '@/src/routes';
import { LanguageSegment } from './language-switcher';

export function UserMenu() {
  const t = useTranslations();
  const auth = useAuth();
  const router = useRouter();
  const user = auth.user;
  const themeLabels = { light: t('common.theme.light'), dark: t('common.theme.dark'), system: t('common.theme.system'), toggle: t('common.theme.toggle') };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label={t('nav.account')}>
          <Avatar>
            {user?.picture ? <AvatarImage src={user.picture} alt="" /> : null}
            <AvatarFallback>{initials(user?.name ?? user?.email)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-[11px] font-normal">{t('nav.signedInAs')}</span>
          <span className="truncate text-sm font-medium text-foreground">{user?.name ?? user?.email}</span>
          {user?.name && user.email ? <span className="truncate text-xs font-normal">{user.email}</span> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <ThemeSegment labels={themeLabels} className="w-full [&>button]:flex-1 [&>button]:justify-center" />
        </div>
        {/* Below `sm` the header has no room for the language menu; this is where a phone finds it. */}
        <div className="px-2 py-1.5">
          <LanguageSegment className="w-full [&>button]:flex-1 [&>button]:justify-center" />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push(routes.app.settings)}>
          <Settings /> {t('nav.settings')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push(routes.mfa)}>
          <ShieldCheck /> {t('auth.mfa.title')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={() => void auth.logout()}>
          <LogOut /> {t('common.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
