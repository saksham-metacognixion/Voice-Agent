'use client';

import { useApi, useListNumbers } from '@portal/api-client';
import { Alert, Button } from '@portal/ui';
import { PhoneOff } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { needingFixSignature, numbersNeedingFix } from '@/src/dashboard/numbers-view';
import { formatPhone } from '@/src/lib/format';
import { numberPath } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';

const DISMISSED_KEY = 'portal:numbers-fix:dismissed';

function readDismissed(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(signature: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, signature);
  } catch {
    // Private window or blocked storage: hidden until the next visit only.
  }
}

/**
 * "Some phone numbers need fixing" (QA-106, ADR 0044) on D1 and the D4 list: numbers with a
 * hand-off target or a blocked caller saved without its country code before the rule, each
 * a link to the tab that fixes it. Worked out from `GET /numbers`, so it goes away once
 * the entries are corrected. Dismissing hides it in this browser until something else is
 * found. Editors and up only: they are the ones who can fix it.
 */
export function NumbersFixNotice() {
  const t = useTranslations('dashboard.numbers.fixNotice');
  const api = useApi();
  const ws = useWorkspace();
  const { canEdit } = useRole();
  const numbers = useListNumbers(api, { staleTime: 10_000, enabled: Boolean(ws.active) && canEdit });
  const found = React.useMemo(() => numbersNeedingFix(numbers.data, ws.workspace?.country), [numbers.data, ws.workspace?.country]);
  const signature = needingFixSignature(found);
  const [hiddenNow, setHiddenNow] = React.useState<string | null>(null);

  if (!canEdit || found.length === 0) return null;
  if (hiddenNow === signature || (typeof window !== 'undefined' && readDismissed() === signature)) return null;

  return (
    <Alert
      variant="warning"
      data-testid="numbers-fix-notice"
      icon={<PhoneOff className="size-5" aria-hidden />}
      title={t('title')}
      actions={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            writeDismissed(signature);
            setHiddenNow(signature);
          }}
        >
          {t('dismiss')}
        </Button>
      }
    >
      <p>{t('body')}</p>
      <ul className="mt-2 flex flex-col gap-1.5 text-sm">
        {found.map(({ number, handoff, blocked }) => {
          const label = number.e164 ? formatPhone(number.e164) : (number.nickname ?? '–');
          return (
            <li key={number.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium tabular-nums" dir="ltr">
                {label}
              </span>
              {handoff ? (
                <Link href={numberPath(number.id, 'handoff')} className="underline">
                  {t('handoff', { count: handoff })}
                </Link>
              ) : null}
              {blocked ? (
                <Link href={numberPath(number.id, 'callers')} className="underline">
                  {t('blocked', { count: blocked })}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Alert>
  );
}
