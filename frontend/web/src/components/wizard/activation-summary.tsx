'use client';

import { useApi, useGetPhonePlan, useGetPricing, useListCalls, useListVoices } from '@portal/api-client';
import type { AgentDetail } from '@portal/schemas';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '@portal/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { formatPhone } from '@/src/lib/format';
import { PRICING_STALE_MS } from '@/src/lib/pricing';
import { routes } from '@/src/routes';
import { summaryRows, type SummaryEdit } from '@/src/wizard/activation-summary';
import { languageName } from '@/src/wizard/languages';

const EDIT_HREF: Record<SummaryEdit, string> = { brief: routes.onboarding.brief, voice: routes.onboarding.voice, phone: routes.onboarding.phone };

/**
 * §8 W7 "Summary card … ✏ Change" (Z-47): what is about to go live, read back from the
 * draft, the pending phone plan, the voice list and the test-call count. Each row links
 * to the step that owns it. Re-reads on every mount, so a change made on W3 or W6 and
 * a Back here shows the new value.
 */
export function ActivationSummary({ agent }: { agent: AgentDetail }) {
  const t = useTranslations('wizard.w7.summary');
  const api = useApi();
  const plan = useGetPhonePlan(api, { id: agent.id }, { staleTime: 0 });
  const pricing = useGetPricing(api, undefined, { staleTime: PRICING_STALE_MS });
  const voices = useListVoices(api, undefined, { staleTime: 10 * 60_000 });
  const tests = useListCalls(api, { is_test: 'true', limit: 1 }, { staleTime: 15_000 });
  const voiceId = agent.draft?.settings.voice_id ?? null;
  const voiceName = voiceId && voices.data ? (voices.data.items.find((v) => v.id === voiceId)?.name ?? null) : null;

  const rows = summaryRows({
    agent,
    plan: plan.data ?? null,
    voiceName,
    testCalls: tests.data?.total ?? null,
    rentalCredits: pricing.data?.recurring.number_rental_credits ?? null,
  });
  const pending = plan.isPending || (voiceId !== null && voices.isPending) || tests.isPending;

  return (
    <Card data-testid="activation-summary">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('body')}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto]" aria-busy={pending || undefined}>
          {rows.map((row) => {
            const values = Object.fromEntries(
              Object.entries(row.value.values ?? {}).map(([k, v]) => [
                k,
                // Phone numbers are shown formatted; the languages row carries locale ids and is shown by name.
                typeof v !== 'string' ? v : v.startsWith('+') ? formatPhone(v) : k === 'list' ? v.split(', ').map(languageName).join(', ') : v,
              ]),
            );
            return (
              <React.Fragment key={row.key}>
                <dt className="font-medium text-muted-foreground sm:pt-0.5">{t(`rows.${row.key}`)}</dt>
                <dd className="min-w-0 break-words" data-testid={`summary-${row.key}`}>
                  {pending && (row.value.id.endsWith('Unknown') || row.value.id === 'noPlan') ? <Skeleton className="h-4 w-32" /> : t(`values.${row.value.id}`, values)}
                </dd>
                <dd className="sm:text-end">
                  {row.edit ? (
                    <Link href={EDIT_HREF[row.edit]} className="text-sm font-medium text-primary underline-offset-4 hover:underline" data-testid={`summary-change-${row.edit}`}>
                      {t('change')}
                    </Link>
                  ) : null}
                </dd>
              </React.Fragment>
            );
          })}
        </dl>
      </CardContent>
    </Card>
  );
}
