'use client';

import { bulkUpdateCalls, exportCalls, useApi, useListAgents, useListCalls } from '@portal/api-client';
import { roleAtLeast, type CallSort } from '@portal/schemas';
import { Button, EmptyState, Skeleton, toast } from '@portal/ui';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCheck, ChevronLeft, ChevronRight, Download, PhoneCall } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { CallDrawer } from '@/src/components/dashboard/call-drawer';
import { CallsFilters } from '@/src/components/dashboard/calls-filters';
import { CallsTable } from '@/src/components/dashboard/calls-table';
import { LiveDot } from '@/src/components/dashboard/live-dot';
import { LoadError } from '@/src/components/dashboard/query-states';
import { PageHeader } from '@/src/components/shell/portal-shell';
import { PAGE_SIZE, callsQueryFor, hasFilters, readCallsView, writeCallsView, type CallsView } from '@/src/dashboard/calls-url';
import { useDashboardLive } from '@/src/dashboard/use-dashboard-live';
import { track } from '@/src/analytics/posthog';
import { errorMessage } from '@/src/lib/errors';
import { formatNumber, formatPhone } from '@/src/lib/format';
import { useUrlQuery } from '@/src/lib/use-url-query';
import { useWorkspace } from '@/src/workspace/workspace-provider';

/**
 * D2 Calls (spec pp. 34–35). The filters, the sort, the page cursor and the open call
 * all live in the URL (`useUrlQuery`), so a refresh, the back button and a pasted link
 * restore the same view; the API request is derived from that one state. Pages are the
 * §16 keyset cursor with the API's total for "1–25 of 312". Selection feeds the bulk
 * "Mark handled" (`PATCH /calls`) and "Export selected"; "Export CSV" takes the current
 * filter (`POST /calls/export`). New calls arrive on the SSE stream.
 */
export default function CallsPage() {
  const t = useTranslations('dashboard.calls');
  const tc = useTranslations();
  const api = useApi();
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const [params, setParams] = useUrlQuery();
  const view = React.useMemo(() => readCallsView(params), [params]);
  const timeZone = ws.workspace?.timezone ?? 'UTC';
  const canEdit = roleAtLeast(ws.workspace?.role ?? 'viewer', 'editor');

  const query = React.useMemo(() => callsQueryFor(view, timeZone), [view, timeZone]);
  const calls = useListCalls(api, query, { staleTime: 10_000 });
  const agents = useListAgents(api, { limit: 100 }, { staleTime: 60_000 });
  const agentName = React.useCallback((id: string | null) => (id ? agents.data?.items.find((a) => a.id === id)?.name : undefined), [agents.data]);

  // Keyset pages. The page number is in the URL with the cursor, so a reload or a pasted
  // link still knows it is page 3; the cursors walked to get there are remembered per
  // filter in this tab's sessionStorage so Previous can step back through them. A pasted
  // link has no such history: Previous from it returns to the first page.
  const pageIndex = view.cursor ? view.page - 1 : 0;
  const filterKey = `${view.status}|${view.agentId}|${view.channel}|${view.test}|${view.handled}|${view.range}|${view.sort}|${view.order}`;
  const cursors = usePageCursors(filterKey);
  React.useEffect(() => cursors.remember(pageIndex, view.cursor), [cursors, pageIndex, view.cursor]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  React.useEffect(() => setSelected(new Set()), [filterKey, view.cursor]);

  const update = React.useCallback(
    (patch: Partial<CallsView>, mode: 'push' | 'replace' = 'push') => {
      setParams((next) => writeCallsView(next, { ...readCallsView(next), ...patch }), mode);
    },
    [setParams],
  );
  const changeFilters = (patch: Partial<CallsView>) => {
    update({ ...patch, cursor: null, page: 1 });
    track('calls_filtered', { keys: Object.keys(patch).join(',') });
  };
  const onSort = (sort: CallSort) => {
    const order = view.sort === sort ? (view.order === 'desc' ? 'asc' : 'desc') : sort === 'started_at' ? 'desc' : 'desc';
    update({ sort, order, cursor: null, page: 1 });
  };
  const nextPage = () => {
    const cursor = calls.data?.next_cursor;
    if (!cursor) return;
    cursors.remember(pageIndex + 1, cursor);
    update({ cursor, page: pageIndex + 2 });
  };
  const prevPage = () => {
    if (pageIndex <= 0) return;
    const prev = cursors.at(pageIndex - 1);
    // Unknown (a pasted link): the first page is the one place we can always get to.
    if (prev === undefined || prev === null) update({ cursor: null, page: 1 });
    else update({ cursor: prev, page: pageIndex });
  };

  const stream = useDashboardLive({
    onNewCall: (call) => {
      toast(call.missed ? tc('dashboard.live.missedCall') : tc('dashboard.live.newCall'), {
        description: call.website ? tc('dashboard.live.fromWebsite') : call.fromNumber ? tc('dashboard.live.from', { number: formatPhone(call.fromNumber) }) : undefined,
        action: { label: tc('dashboard.live.view'), onClick: () => update({ callId: call.callId }, 'replace') },
      });
    },
  });

  const [bulkBusy, setBulkBusy] = React.useState(false);
  async function markHandled() {
    if (selected.size === 0) return;
    setBulkBusy(true);
    try {
      const res = await bulkUpdateCalls(api, { ids: [...selected], handled: true });
      toast.success(t('bulk.done', { n: res.updated }));
      track('calls_bulk_handled', { count: res.updated });
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ['listCalls'] });
    } catch (e) {
      toast.error(errorMessage(e, tc));
    } finally {
      setBulkBusy(false);
    }
  }

  const [exporting, setExporting] = React.useState(false);
  async function download(ids?: string[]) {
    setExporting(true);
    try {
      const { limit: _limit, cursor: _cursor, ...filters } = query;
      const { blob, filename } = await exportCalls(api, { ...filters, ...(ids ? { ids } : {}) });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(t('export.done'));
      track('calls_exported', { selected: ids?.length ?? null });
    } catch (e) {
      toast.error(errorMessage(e, tc));
    } finally {
      setExporting(false);
    }
  }

  const items = calls.data?.items ?? [];
  const total = calls.data?.total;
  const first = pageIndex * PAGE_SIZE + 1;
  const last = pageIndex * PAGE_SIZE + items.length;

  return (
    <>
      <PageHeader
        title={t('title')}
        description={total !== undefined ? t('count', { n: formatNumber(total, 0) }) : undefined}
        actions={
          <>
            <LiveDot state={stream} />
            {canEdit ? (
              <Button variant="outline" size="sm" loading={exporting} disabled={!items.length} onClick={() => void download()}>
                <Download /> {t('export.button')}
              </Button>
            ) : null}
          </>
        }
      />
      <CallsFilters view={view} agents={agents.data?.items ?? []} onChange={changeFilters} />

      {canEdit && selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-accent/40 px-3 py-2 text-sm" role="status">
          <span className="font-medium">{t('bulk.selected', { n: selected.size })}</span>
          <Button size="sm" loading={bulkBusy} onClick={() => void markHandled()}>
            <CheckCheck /> {t('bulk.markHandled')}
          </Button>
          <Button size="sm" variant="outline" loading={exporting} onClick={() => void download([...selected])}>
            <Download /> {t('bulk.export')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {t('bulk.clear')}
          </Button>
        </div>
      ) : null}

      {calls.isPending ? (
        <div className="flex flex-col gap-2" aria-busy>
          <Skeleton className="h-10 w-full" />
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : calls.isError ? (
        <LoadError error={calls.error} onRetry={() => void calls.refetch()} title={t('loadFailed')} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<PhoneCall />}
          title={hasFilters(view) ? t('emptyFiltered') : t('empty')}
          action={hasFilters(view) ? <Button variant="outline" size="sm" onClick={() => changeFilters({ status: null, agentId: null, channel: null, test: null, handled: null, range: 'all' })}>{t('filters.clear')}</Button> : undefined}
        />
      ) : (
        <>
          <CallsTable
            calls={items}
            agentName={agentName}
            timeZone={ws.workspace?.timezone}
            sort={view.sort}
            order={view.order}
            onSort={onSort}
            onSortChange={(sort, order) => update({ sort, order, cursor: null, page: 1 })}
            selected={selected}
            onSelect={(id, checked) =>
              setSelected((s) => {
                const next = new Set(s);
                if (checked) next.add(id);
                else next.delete(id);
                return next;
              })
            }
            onSelectAll={(checked) => setSelected(checked ? new Set(items.map((c) => c.id)) : new Set())}
            canSelect={canEdit}
            activeId={view.callId}
            onOpen={(id) => update({ callId: id }, 'replace')}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>{total !== undefined ? t('showing', { first, last, total: formatNumber(total, 0) }) : t('showingPage', { first, last })}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={pageIndex <= 0 || calls.isFetching} onClick={prevPage}>
                <ChevronLeft /> {t('previous')}
              </Button>
              <Button variant="outline" size="sm" disabled={!calls.data.next_cursor || calls.isFetching} loading={calls.isFetching && Boolean(view.cursor)} onClick={nextPage}>
                {t('next')} <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      )}

      <CallDrawer callId={view.callId} onClose={() => update({ callId: null }, 'replace')} />
    </>
  );
}

/**
 * The cursor that opens each page of one filter, index = page − 1 (page one is `null`),
 * kept in sessionStorage so it survives a reload and dies with the tab. Storage may be
 * missing or refused (private windows); then it is an in-memory list for this render tree.
 */
function usePageCursors(filterKey: string): { at: (index: number) => string | null | undefined; remember: (index: number, cursor: string | null) => void } {
  const key = `calls-cursors:${filterKey}`;
  const fallback = React.useRef<Array<string | null>>([null]);
  React.useEffect(() => {
    fallback.current = [null];
  }, [key]);
  const read = React.useCallback((): Array<string | null> => {
    try {
      const raw = window.sessionStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) return parsed.map((c) => (typeof c === 'string' ? c : null));
    } catch {
      // fall through to the in-memory copy
    }
    return fallback.current;
  }, [key]);
  return React.useMemo(
    () => ({
      at: (index) => read()[index],
      remember: (index, cursor) => {
        const list = [...read()];
        if (list[index] === cursor) return;
        list[index] = cursor;
        fallback.current = list;
        try {
          window.sessionStorage.setItem(key, JSON.stringify(list));
        } catch {
          // storage refused: the in-memory copy still serves this tab
        }
      },
    }),
    [key, read],
  );
}
