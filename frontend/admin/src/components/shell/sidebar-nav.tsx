'use client';

import { Badge, cn } from '@portal/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS, isNavActive } from './nav-items';

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-2" aria-label="Sections">
      {NAV_ITEMS.map((item) => {
        const active = isNavActive(item, pathname);
        return (
          <Link
            key={item.key}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground',
              active && 'bg-sidebar-accent text-sidebar-accent-foreground',
            )}
          >
            <item.icon className="size-4 shrink-0" aria-hidden />
            <span className="flex-1 truncate">{item.label}</span>
            {item.p2 ? (
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                P2
              </Badge>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
