'use client';

import {
  Avatar, AvatarFallback, AvatarImage, Badge, Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
  ThemeSegment, initials,
} from '@portal/ui';
import { LogOut } from 'lucide-react';
import { useAuth } from '@/src/auth/auth-provider';
import { ROLE_LABELS } from '@/src/lib/permissions';
import { useStaff } from '@/src/staff/staff-provider';

export function StaffMenu() {
  const auth = useAuth();
  const { me } = useStaff();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account">
          <Avatar>
            {auth.user?.picture ? <AvatarImage src={auth.user.picture} alt="" /> : null}
            <AvatarFallback>{initials(me.name ?? me.email)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-1">
          <span className="truncate text-sm font-medium text-foreground">{me.name ?? me.email}</span>
          {me.name ? <span className="truncate text-xs font-normal">{me.email}</span> : null}
          <span>
            <Badge variant="primary">{ROLE_LABELS[me.role]}</Badge>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <ThemeSegment className="w-full [&>button]:flex-1 [&>button]:justify-center" />
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={() => void auth.logout()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
