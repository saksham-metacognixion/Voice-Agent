'use client';

import { isApiError, useApi, useGetNumber } from '@portal/api-client';
import type { PhoneNumberResponse } from '@portal/schemas';
import { Alert, Button, EmptyState, PageLoader, Tabs, TabsContent, TabsList, TabsTrigger } from '@portal/ui';
import { ArrowLeft, Pencil, Phone } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { LoadError } from '@/src/components/dashboard/query-states';
import { areaCodeSubstitute, isNumberEditable, numberType } from '@/src/dashboard/numbers-view';
import { formatDate } from '@/src/lib/format';
import { NUMBER_TABS, routes, type NumberTab } from '@/src/routes';
import { useRole } from '@/src/workspace/use-role';
import { useWorkspace } from '@/src/workspace/workspace-provider';
import { NumberLabel, NumberStatusBadge, NumberTypeBadge, useAgentsForNumbers, useNumbersNav } from './number-bits';
import { CallersSection, DangerSection, ForwardingSection, HandoffSection, RoutingSection, SipSection } from './number-sections';
import { RenameNumberDialog } from './rename-number-dialog';

/** The sections a number has: Forwarding only for a forward target, SIP only for a SIP line. */
export function tabsFor(number: Pick<PhoneNumberResponse, 'kind' | 'forwarding'>): NumberTab[] {
  const type = numberType(number);
  return NUMBER_TABS.filter((tab) => (tab === 'forwarding' ? type === 'forward' : tab === 'sip' ? type === 'sip' : true));
}

/**
 * D4 detail (spec p. 37): `/app/numbers/[id]` in the spec, `?id=&tab=` in the export.
 * Routing, hand-off and callers are `PATCH /numbers/:id` (editor and up); release is
 * owner/admin. A released number is shown read-only — its calls still reference it.
 */
export function NumberDetail({ id, tab, onTab }: { id: string; tab: string | null; onTab: (tab: NumberTab) => void }) {
  const t = useTranslations('dashboard.numbers');
  const api = useApi();
  const ws = useWorkspace();
  const { canEdit } = useRole();
  // Poll while the platform is still setting it up or letting it go — the query's own
  // interval, as the list does, not a timer re-armed by every render.
  const [polling, setPolling] = React.useState(false);
  const number = useGetNumber(api, { id }, { staleTime: 10_000, refetchInterval: polling ? 3_000 : false });
  const agents = useAgentsForNumbers();
  const [renaming, setRenaming] = React.useState(false);
  const nav = useNumbersNav();

  const settling = number.data?.status === 'provisioning' || number.data?.status === 'releasing';
  React.useEffect(() => setPolling(settling), [settling]);

  if (number.isPending) return <PageLoader />;
  if (number.isError) {
    if (isApiError(number.error) && number.error.status === 404) {
      return (
        <EmptyState
          icon={<Phone />}
          title={t('notFound')}
          action={
            <Button variant="outline" onClick={() => nav.list()}>
              {t('back')}
            </Button>
          }
        />
      );
    }
    return <LoadError error={number.error} onRetry={() => void number.refetch()} />;
  }

  const n = number.data;
  const tabs = tabsFor(n);
  const active = (tabs as string[]).includes(tab ?? '') ? (tab as NumberTab) : 'routing';
  const editable = isNumberEditable(n);
  const substitute = areaCodeSubstitute(n);
  const agentName = n.agent_id ? (agents.name(n.agent_id) ?? t('unknownAgent')) : t('noAgent');

  return (
    <>
      <div className="flex flex-col gap-3">
        <Link
          href={routes.app.numbers}
          onClick={(e) => {
            e.preventDefault();
            nav.list();
          }}
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden /> {t('back')}
        </Link>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="break-words text-2xl font-semibold tracking-tight">
              <NumberLabel number={n} />
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <NumberStatusBadge status={n.status} />
              <NumberTypeBadge number={n} />
              {n.nickname ? <span className="break-words" dir="auto">{n.nickname}</span> : null}
              <span aria-hidden>·</span>
              <span className="break-words" dir="auto">{agentName}</span>
              {n.next_rental_at && n.rental_credits > 0 && editable ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{t('nextRental', { date: formatDate(n.next_rental_at, ws.workspace?.timezone) })}</span>
                </>
              ) : null}
            </div>
          </div>
          {canEdit && editable ? (
            <Button variant="outline" size="sm" onClick={() => setRenaming(true)}>
              <Pencil /> {t('rename')}
            </Button>
          ) : null}
        </div>
      </div>

      {n.status === 'released' ? <Alert variant="neutral">{t('releasedNote')}</Alert> : null}
      {substitute && editable ? <Alert variant="neutral">{t('areaCodeNote', substitute)}</Alert> : null}
      {n.status === 'failed' && n.error ? <Alert variant="danger">{t('failedNote', { reason: n.error })}</Alert> : null}
      {!canEdit && editable ? <Alert variant="neutral">{t('readOnly')}</Alert> : null}

      <Tabs value={active} onValueChange={(v) => onTab(v as NumberTab)}>
        <TabsList aria-label={t('tabs.label')}>
          {tabs.map((key) => (
            <TabsTrigger key={key} value={key}>
              {t(`tabs.${key}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="routing">
          <RoutingSection number={n} disabled={!canEdit || !editable} />
        </TabsContent>
        <TabsContent value="handoff">
          <HandoffSection number={n} disabled={!canEdit || !editable} />
        </TabsContent>
        <TabsContent value="callers">
          <CallersSection number={n} disabled={!canEdit || !editable} />
        </TabsContent>
        {tabs.includes('forwarding') ? (
          <TabsContent value="forwarding">
            <ForwardingSection number={n} disabled={!canEdit || !editable} />
          </TabsContent>
        ) : null}
        {tabs.includes('sip') ? (
          <TabsContent value="sip">
            <SipSection number={n} />
          </TabsContent>
        ) : null}
        <TabsContent value="danger">
          <DangerSection number={n} />
        </TabsContent>
      </Tabs>
      <RenameNumberDialog number={renaming ? n : null} onOpenChange={setRenaming} />
    </>
  );
}
