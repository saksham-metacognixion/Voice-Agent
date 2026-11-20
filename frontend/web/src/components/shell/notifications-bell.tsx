'use client';

import { useApi, useListNotifications, useMarkNotificationsSeen } from '@portal/api-client';
import type { NotificationItemResponse } from '@portal/schemas';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, cn } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Bell, Coins, CreditCard, MessageSquare, Phone, PhoneOff, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { knownNotifications, notificationHref, relativeAge, unreadBadge } from '@/src/dashboard/notifications-view';
import { activeIntlLocale } from '@/src/i18n';
import { errorMessage } from '@/src/lib/errors';
import { formatCreditsValue, formatPhone } from '@/src/lib/format';
import { useWorkspace } from '@/src/workspace/workspace-provider';

const ICONS = {
  low_balance: Coins,
  auto_topup_failed: CreditCard,
  rental_overdue: Coins,
  message_captured: MessageSquare,
  number_active: Phone,
  number_released: PhoneOff,
  member_joined: UserPlus,
} as const;

/**
 * §7.2 notifications bell (ADR 0041): the caller's recent rows from `GET /notifications`
 * — low balance, a message captured, a number gone live, a failed auto top-up, a member
 * joined — with the unread count on the bell. Opening it posts `/notifications/seen`,
 * so the count clears for this member only. The `notifications` SSE topic refetches the
 * list, so a message taken while the dashboard is open shows up without a reload.
 */
export function NotificationsBell({ className }: { className?: string }) {
  const t = useTranslations('shell.notifications');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const feed = useListNotifications(api, { enabled: Boolean(ws.active), staleTime: 30_000 });
  const seen = useMarkNotificationsSeen(api);
  const [open, setOpen] = React.useState(false);
  const [now, setNow] = React.useState(() => new Date());
  // The rows that were unread when the menu opened. Opening posts "seen" and the refetch
  // answers every row as read a moment later; these keep their mark until the menu closes,
  // so the new ones can still be told apart while they are being read.
  const [fresh, setFresh] = React.useState<ReadonlySet<string>>(NONE);

  const unread = feed.data?.unread ?? 0;
  const badge = unreadBadge(unread);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setFresh(NONE);
      return;
    }
    setNow(new Date());
    setFresh(new Set((feed.data?.items ?? []).filter((i) => i.unread).map((i) => i.id)));
    if (unread > 0 && !seen.isPending) {
      seen.mutateAsync().then(
        () => queryClient.invalidateQueries({ queryKey: ['listNotifications'] }),
        () => null, // The count stays; the next open tries again.
      );
    }
  }

  const items = feed.data ? knownNotifications(feed.data.items) : [];

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn('relative rounded-full', className)} aria-label={badge ? t('ariaUnread', { n: unread }) : t('aria')} data-testid="notifications-bell">
          <Bell className="size-5" aria-hidden />
          {badge ? (
            <span data-testid="notifications-unread" className="absolute -end-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
              {badge}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>{t('title')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {feed.isPending ? (
          <p className="px-2 py-3 text-sm text-muted-foreground" aria-busy>{tc('common.loading')}</p>
        ) : feed.isError ? (
          <div className="flex flex-col gap-2 px-2 py-3 text-sm">
            <p className="text-muted-foreground">{t('loadFailed')}: {errorMessage(feed.error, tc)}</p>
            <Button size="sm" variant="outline" className="self-start" onClick={() => void feed.refetch()}>{tc('common.retry')}</Button>
          </div>
        ) : items.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {items.map((item) => (
              <li key={item.id}>
                <DropdownMenuItem asChild className="items-start gap-3 py-2">
                  <Link href={notificationHref(item)}>
                    <NotificationLine item={item} unread={item.unread || fresh.has(item.id)} now={now} />
                  </Link>
                </DropdownMenuItem>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NONE: ReadonlySet<string> = new Set();

function NotificationLine({ item, unread, now }: { item: NotificationItemResponse; unread: boolean; now: Date }) {
  const t = useTranslations('shell.notifications.kind');
  const Icon = ICONS[item.kind] ?? Bell;
  const meta = item.meta ?? {};
  const text = (() => {
    switch (item.kind) {
      case 'low_balance':
        return typeof meta.balance === 'number' ? t('low_balance', { balance: formatCreditsValue(meta.balance) }) : t('low_balance_plain');
      case 'message_captured':
        return typeof meta.from_number === 'string' && meta.from_number ? t('message_captured', { number: formatPhone(meta.from_number) }) : t('message_captured_plain');
      case 'number_active':
        return typeof meta.e164 === 'string' && meta.e164 ? t('number_active', { number: formatPhone(meta.e164) }) : t('number_active_plain');
      case 'number_released':
        return typeof meta.e164 === 'string' && meta.e164 ? t('number_released', { number: formatPhone(meta.e164) }) : t('number_released_plain');
      case 'member_joined':
        return typeof meta.email === 'string' && meta.email ? t('member_joined', { email: meta.email }) : t('member_joined_plain');
      case 'rental_overdue':
        return t('rental_overdue');
      case 'auto_topup_failed':
      default:
        return t('auto_topup_failed');
    }
  })();
  return (
    <>
      <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full', unread ? 'bg-primary/12 text-accent-foreground' : 'bg-muted text-muted-foreground')}>
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span dir="auto" className={cn('text-sm leading-snug', unread ? 'font-medium text-foreground' : 'text-foreground/90')}>{text}</span>
        <span className="text-[11px] text-muted-foreground">{relativeAge(item.created_at, now, activeIntlLocale())}</span>
      </span>
      {unread ? <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-hidden /> : null}
    </>
  );
}
