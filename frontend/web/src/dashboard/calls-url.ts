import type { CallChannel, CallDisplayStatus, CallSort, CallsQuery, SortOrder } from '@portal/schemas';
import { localDate, shiftDate, startOfLocalDay } from '../lib/format';

export type RangePreset = 'all' | 'today' | '7d' | '30d';
export const RANGE_PRESETS: RangePreset[] = ['all', 'today', '7d', '30d'];
export const CALL_STATUSES: CallDisplayStatus[] = ['in_progress', 'ended', 'analyzed', 'missed'];
export const CALL_SORTS: CallSort[] = ['started_at', 'duration_s', 'credits_charged'];
export const PAGE_SIZE = 25;

/** The D2 filter state, as the URL carries it (`/app/calls/?status=missed&agent=…`). */
export interface CallsView {
  status: CallDisplayStatus | null;
  agentId: string | null;
  channel: CallChannel | null;
  /** `true` = only test calls, `false` = hide them, null = both. */
  test: boolean | null;
  handled: boolean | null;
  range: RangePreset;
  sort: CallSort;
  order: SortOrder;
  cursor: string | null;
  /**
   * 1-based page the cursor opens, so a pasted or reloaded `?cursor=` still labels itself
   * "26–50 of 312" and can step back. A cursor without a page is read as page 2: the
   * cursor itself says it is not the first page, and the count is the least it can be.
   */
  page: number;
  callId: string | null;
}

export const DEFAULT_VIEW: CallsView = { status: null, agentId: null, channel: null, test: null, handled: null, range: 'all', sort: 'started_at', order: 'desc', cursor: null, page: 1, callId: null };

/** Reads the view from the query string; anything malformed falls back to the default. */
export function readCallsView(params: URLSearchParams): CallsView {
  const pick = <T extends string>(key: string, allowed: readonly T[]): T | null => {
    const v = params.get(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : null;
  };
  const bool = (key: string): boolean | null => {
    const v = params.get(key);
    return v === 'true' ? true : v === 'false' ? false : null;
  };
  const agent = params.get('agent');
  const cursor = params.get('cursor');
  const page = Number(params.get('page'));
  return {
    status: pick('status', CALL_STATUSES),
    agentId: agent && /^[0-9a-f-]{36}$/i.test(agent) ? agent : null,
    channel: pick('channel', ['phone', 'web'] as const),
    test: bool('test'),
    handled: bool('handled'),
    range: pick('range', RANGE_PRESETS) ?? 'all',
    sort: pick('sort', CALL_SORTS) ?? 'started_at',
    order: pick('order', ['asc', 'desc'] as const) ?? 'desc',
    cursor,
    page: !cursor ? 1 : Number.isInteger(page) && page >= 2 ? page : 2,
    callId: params.get('call'),
  };
}

/** Writes the view back; a default value is left out so the URL stays short. */
export function writeCallsView(params: URLSearchParams, view: CallsView): void {
  const set = (key: string, value: string | null | undefined, def?: string) => {
    if (value === null || value === undefined || value === def) params.delete(key);
    else params.set(key, value);
  };
  set('status', view.status);
  set('agent', view.agentId);
  set('channel', view.channel);
  set('test', view.test === null ? null : String(view.test));
  set('handled', view.handled === null ? null : String(view.handled));
  set('range', view.range, 'all');
  set('sort', view.sort, 'started_at');
  set('order', view.order, 'desc');
  set('cursor', view.cursor);
  set('page', view.cursor && view.page > 1 ? String(view.page) : null);
  set('call', view.callId);
}

/** The `from` bound for a preset: the start of the local day `days - 1` days ago, in the workspace zone. */
export function rangeFrom(range: RangePreset, timeZone: string, now = new Date()): string | undefined {
  if (range === 'all') return undefined;
  const days = range === 'today' ? 1 : range === '7d' ? 7 : 30;
  return startOfLocalDay(shiftDate(localDate(now, timeZone), -(days - 1)), timeZone).toISOString();
}

/** The `GET /calls` query for a view. `from` is computed in the workspace timezone. */
export function callsQueryFor(view: CallsView, timeZone: string, now = new Date()): CallsQueryInput {
  return {
    limit: PAGE_SIZE,
    ...(view.cursor ? { cursor: view.cursor } : {}),
    ...(view.status ? { status: view.status } : {}),
    ...(view.agentId ? { agent_id: view.agentId } : {}),
    ...(view.channel ? { channel: view.channel } : {}),
    ...(view.test === null ? {} : { is_test: view.test ? 'true' : 'false' }),
    ...(view.handled === null ? {} : { handled: view.handled ? 'true' : 'false' }),
    ...(rangeFrom(view.range, timeZone, now) ? { from: rangeFrom(view.range, timeZone, now) } : {}),
    sort: view.sort,
    order: view.order,
  };
}

/** `callsQuery`'s input shape: the boolean filters travel as the strings the API parses. */
export type CallsQueryInput = Omit<Partial<CallsQuery>, 'is_test' | 'handled'> & { is_test?: 'true' | 'false'; handled?: 'true' | 'false' };

export function hasFilters(view: CallsView): boolean {
  return Boolean(view.status || view.agentId || view.channel || view.test !== null || view.handled !== null || view.range !== 'all');
}
