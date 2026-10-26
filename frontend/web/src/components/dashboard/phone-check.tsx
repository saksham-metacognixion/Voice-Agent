'use client';

import type { CapturedPhoneCheck } from '@portal/schemas';
import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * The server's verdict on one captured phone number (`captured_checks`, `GET /calls/:id`):
 * nothing when it matches what the caller said, otherwise a warning under the value and
 * the digits the caller actually said. Shown wherever captured fields are — the D2
 * drawer and the W5 after-call card — so staff never ring an invented number unwarned.
 */
export function PhoneCheckNote({ check }: { check: CapturedPhoneCheck | undefined }) {
  const t = useTranslations('dashboard.calls.phoneCheck');
  if (!check || check.status === 'ok') return null;
  return (
    <div className="mt-1 flex items-start gap-1.5 text-start text-xs font-normal text-warning-emphasis">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="flex flex-col gap-0.5">
        <span>{check.status === 'mismatch' ? t('mismatch') : t('invalid', { digits: check.digits })}</span>
        {check.heard.length ? (
          <span>
            {t.rich('heard', {
              numbers: check.heard.join(', '),
              num: (chunks) => (
                <bdi dir="ltr" className="font-medium">
                  {chunks}
                </bdi>
              ),
            })}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** One line under the summary when any captured number failed its check. */
export function PhoneSummaryNote({ checks, captured }: { checks: readonly CapturedPhoneCheck[] | undefined; captured: string }) {
  const t = useTranslations('dashboard.calls.phoneCheck');
  if (!checks?.some((c) => c.status !== 'ok')) return null;
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-warning-emphasis">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{t('summary', { captured })}</span>
    </p>
  );
}
