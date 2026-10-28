import { Injectable, Logger } from '@nestjs/common';
import { Prisma, withWorkspace } from '@portal/db';
import {
  CALLS_EXPORT_MAX_ROWS,
  type CallDetail,
  type CallDisplayStatus,
  type CallFilters,
  type CallPatch,
  type CallSort,
  type CallSummary,
  type CallsBulkPatch,
  type CallsBulkResponse,
  type CallsExportRequest,
  type CallsQuery,
  type DeclineReason,
  type Page,
  type SortOrder,
  type StatsQuery,
  type StatsResponse,
  type TransferStatus,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, toPage } from '../../common/pagination';
import type { WorkspaceContext } from '../auth';
import { JobQueues } from '../jobs';
import { RetellGateway } from '../retell';
import { unsettledCallKind } from './call-recovery.rules';
import { resolveWindow } from './stats-window';
import { phoneRegions } from '../../common/phone-regions';
import { callerUtterances, checkCapturedPhones } from './captured-phones';
import { csvHeader, csvRow } from './csv';
import { knowledgeUseOf, storedSourceIds } from './kb-usage';
import { RecordingSigner } from './recording';

/** A call row as the customer reads it, before it becomes a response. */
type CallRow = Prisma.CallGetPayload<{ select: typeof CALL_SELECT }>;

const CALL_SELECT = {
  id: true,
  agentId: true,
  agentVersion: true,
  numberId: true,
  channel: true,
  direction: true,
  isTest: true,
  fromNumber: true,
  toNumber: true,
  startedAt: true,
  endedAt: true,
  durationS: true,
  disconnectionReason: true,
  tier: true,
  rate: true,
  configVersion: true,
  creditsCharged: true,
  transferCreditsCharged: true,
  status: true,
  declineReason: true,
  outcome: true,
  handledAt: true,
  note: true,
  recordingUrl: true,
  analysisJson: true,
  createdAt: true,
} satisfies Prisma.CallSelect;

/**
 * `recoveryChecks` feeds `unsettledCallKind` (ADR 0011 §7) and is not on the wire; the
 * workspace's country and the agent's locales are the regions a captured phone number
 * is validated in (`captured_checks`).
 */
const DETAIL_SELECT = {
  ...CALL_SELECT,
  transcriptText: true,
  transcriptJson: true,
  recoveryChecks: true,
  transferStatus: true,
  transferBridgedAt: true,
  transferEndedAt: true,
  transferDurationS: true,
  transferRate: true,
  kbRetrievals: true,
  kbHits: true,
  kbUsageJson: true,
  tenant: { select: { country: true } },
  agent: { select: { primaryLanguage: true, languages: true } },
} satisfies Prisma.CallSelect;
type DetailRow = Prisma.CallGetPayload<{ select: typeof DETAIL_SELECT }>;

/** The columns a keyset cursor resumes from: the sort column, then the tiebreakers. */
const POSITION_SELECT = { id: true, startedAt: true, durationS: true, creditsCharged: true, createdAt: true } satisfies Prisma.CallSelect;
type CursorRow = Prisma.CallGetPayload<{ select: typeof POSITION_SELECT }>;

/** Rows read per round trip while streaming an export. */
const EXPORT_BATCH = 500;

/**
 * The customer-facing reads of D2 and D1: `GET /calls`, `GET /calls/:id`,
 * `PATCH /calls/:id`, the recording proxy and `GET /stats` (§16).
 *
 * Every query runs inside `withWorkspace(ctx)`, so RLS is the second guard and a call id
 * belonging to another workspace is simply not there — the 404 is the same answer the
 * customer gets for an id that never existed, which is what stops id probing.
 *
 * No network I/O inside the callback (ADR 0006): the recording proxy reads the row, closes
 * the transaction, and only then talks to Retell.
 */
@Injectable()
export class CallsQueryService {
  private readonly log = new Logger(CallsQueryService.name);

  constructor(
    private readonly signer: RecordingSigner,
    private readonly retell: RetellGateway,
    private readonly queues: JobQueues,
  ) {}

  async list(ctx: WorkspaceContext, query: CallsQuery): Promise<Page<CallSummary>> {
    const where = this.filter(ctx.workspaceId, query);
    const cursorId = query.cursor ? decodeCursor(query.cursor).id : null;
    const { rows, total } = await withWorkspace(ctx, async (db) => {
      // The cursor row is read under RLS: another workspace's id, like one that never
      // existed, is simply not there and the page link is refused — never a leak.
      const position = cursorId ? await db.call.findFirst({ where: { id: cursorId, tenantId: ctx.workspaceId }, select: POSITION_SELECT }) : null;
      if (cursorId && !position) throw invalidCursor();
      const [rows, total] = await Promise.all([
        db.call.findMany({
          take: query.limit + 1,
          where: position ? { AND: [where, afterPosition(query.sort, query.order, position)] } : where,
          orderBy: orderBy(query.sort, query.order),
          select: CALL_SELECT,
        }),
        // Indexed on (tenant_id, started_at) and (tenant_id, status); a count is one index
        // scan and is what lets the D2 pager say "1–25 of 312".
        db.call.count({ where }),
      ]);
      return { rows, total };
    });
    const page = toPage(rows, query);
    return { next_cursor: page.next_cursor, items: page.items.map(toSummary), total };
  }

  /**
   * `PATCH /calls {ids, handled}` — the D2 bulk action. One `updateMany` under RLS: an id
   * from another workspace matches nothing and is neither an error nor a leak. Marking a
   * call handled keeps the time it was first handled; unmarking clears it.
   */
  async bulkPatch(ctx: WorkspaceContext, body: CallsBulkPatch): Promise<CallsBulkResponse> {
    const ids = [...new Set(body.ids)];
    const updated = await withWorkspace(ctx, async (db) => {
      const where: Prisma.CallWhereInput = { id: { in: ids }, tenantId: ctx.workspaceId };
      if (body.handled) await db.call.updateMany({ where: { ...where, handledAt: null }, data: { handledAt: new Date() } });
      else await db.call.updateMany({ where, data: { handledAt: null } });
      // The answer is how many of the ids are now in the asked-for state — the customer
      // asked for a state, not a write, so a row that was already there counts; one from
      // another workspace, or an id that never existed, does not.
      return db.call.count({ where: { ...where, handledAt: body.handled ? { not: null } : null } });
    });
    return { updated };
  }

  /**
   * `POST /calls/export` — the filtered list as CSV, streamed in batches so a big export
   * never holds every row in memory or a transaction open for its whole duration. Each
   * batch is its own `withWorkspace` (no long-lived connection, ADR 0006), resumed by
   * keyset on the same total order the list uses, capped at `CALLS_EXPORT_MAX_ROWS`.
   */
  async *exportCsv(ctx: WorkspaceContext, body: CallsExportRequest): AsyncGenerator<string> {
    yield csvHeader();
    const where = this.filter(ctx.workspaceId, body);
    if (body.ids?.length) where.id = { in: [...new Set(body.ids)] };
    const order = orderBy(body.sort, body.order);

    let position: CursorRow | null = null;
    let written = 0;
    while (written < CALLS_EXPORT_MAX_ROWS) {
      const take = Math.min(EXPORT_BATCH, CALLS_EXPORT_MAX_ROWS - written);
      const after = position ? afterPosition(body.sort, body.order, position) : null;
      const rows: CallRow[] = await withWorkspace(ctx, (db) =>
        db.call.findMany({
          where: after ? { AND: [where, after] } : where,
          orderBy: order,
          take,
          select: CALL_SELECT,
        }),
      );
      for (const row of rows) yield csvRow(toSummary(row));
      written += rows.length;
      if (rows.length < take) return;
      position = rows[rows.length - 1]!;
    }
  }

  async get(ctx: WorkspaceContext, callId: string): Promise<CallDetail> {
    const found = await withWorkspace(ctx, async (db) => {
      const row = await db.call.findFirst({ where: { id: callId, tenantId: ctx.workspaceId }, select: DETAIL_SELECT });
      return row ? { row, names: await sourceNames(db, row, ctx.workspaceId) } : null;
    });
    if (!found) throw AppError.notFound('Call');
    const { row, names } = found;
    if (unsettledCallKind(row)) {
      // Someone is waiting on this call. If the platform dropped its call_ended /
      // call_analyzed, settle it now rather than at the next 5-minute call-recovery tick
      // (ADR 0011 §7). Not awaited; JobQueues bounds, dedupes and logs the enqueue.
      void this.queues.enqueueRecoverCall(row.id);
    }
    return toDetail(row, names);
  }

  /** D2 detail actions: mark handled, leave a note. */
  async patch(ctx: WorkspaceContext, callId: string, body: CallPatch): Promise<CallDetail> {
    const updated = await withWorkspace(ctx, async (db) => {
      const exists = await db.call.findFirst({ where: { id: callId, tenantId: ctx.workspaceId }, select: { id: true, handledAt: true } });
      if (!exists) return null;
      const row = await db.call.update({
        where: { id: callId },
        data: {
          ...(body.handled === undefined ? {} : { handledAt: body.handled ? (exists.handledAt ?? new Date()) : null }),
          ...(body.note === undefined ? {} : { note: body.note }),
        },
        select: DETAIL_SELECT,
      });
      return { row, names: await sourceNames(db, row, ctx.workspaceId) };
    });
    if (!updated) throw AppError.notFound('Call');
    return toDetail(updated.row, updated.names);
  }

  /**
   * `GET /calls/:id/recording` → a signed link to our own streaming route, valid one hour
   * (§17). The Retell URL is never handed to the browser: it is a bearer credential for
   * audio we are custodian of, and it outlives any check we would do here.
   */
  async recordingLink(ctx: WorkspaceContext, callId: string, origin: string): Promise<{ url: string; expires_at: string; download_url: string | null }> {
    const row = await withWorkspace(ctx, (db) =>
      db.call.findFirst({ where: { id: callId, tenantId: ctx.workspaceId }, select: { id: true, recordingUrl: true } }),
    );
    if (!row) throw AppError.notFound('Call');
    if (!row.recordingUrl) throw AppError.notFound('Recording');
    const now = new Date();
    const stream = `${origin.replace(/\/+$/, '')}/calls/${encodeURIComponent(callId)}/recording/stream`;
    const { token, expiresAt } = this.signer.sign({ callId, workspaceId: ctx.workspaceId }, now);
    // Spec D2 "Download (Owner/Admin)" (QA-077): a separate token purpose, so the stream
    // can tell a download an owner/admin was given from an editor's playback link.
    const download = ctx.role === 'owner' || ctx.role === 'admin' ? this.signer.sign({ callId, workspaceId: ctx.workspaceId }, now, undefined, 'download').token : null;
    return {
      url: `${stream}?token=${token}`,
      expires_at: expiresAt.toISOString(),
      download_url: download ? `${stream}?token=${download}&download=1` : null,
    };
  }

  /**
   * Resolves a signed token to a playable Retell URL. Called by the @Public() streaming
   * route: the token is the credential, so this re-checks that it names this call and
   * that the recording still exists, and never trusts the path alone.
   *
   * Retell's stored URL is itself signed and expires (`opt_in_signed_url`), so a stale one
   * is refreshed from `get-call` — outside any transaction.
   */
  async resolveRecording(callId: string, token: string | undefined, purpose: 'recording' | 'download' = 'recording'): Promise<{ url: string }> {
    const claims = this.signer.verify(token, undefined, purpose);
    if (!claims || claims.callId !== callId) throw new AppError('UNAUTHENTICATED', 'That recording link has expired.');

    const row = await withWorkspace(claims.workspaceId, (db) =>
      db.call.findFirst({ where: { id: callId, tenantId: claims.workspaceId }, select: { id: true, recordingUrl: true } }),
    );
    if (!row?.recordingUrl) throw AppError.notFound('Recording');

    if (isFresh(row.recordingUrl)) return { url: row.recordingUrl };
    try {
      const call = await this.retell.getCall(callId);
      const fresh = (call as { recording_url?: string | null }).recording_url;
      if (fresh) {
        await withWorkspace(claims.workspaceId, (db) => db.call.update({ where: { id: callId }, data: { recordingUrl: fresh } }));
        return { url: fresh };
      }
    } catch (error) {
      this.log.warn(`could not refresh the recording URL for ${callId}: ${String(error)}`);
    }
    return { url: row.recordingUrl };
  }

  /** `GET /stats?range=` — the D1 Home widgets, in the workspace's timezone. */
  async stats(ctx: WorkspaceContext, query: StatsQuery): Promise<StatsResponse> {
    const { tenant, window } = await withWorkspace(ctx, async (db) => {
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { timezone: true } });
      return { tenant, window: resolveWindow(query, tenant.timezone) };
    });

    const { from, to } = window;
    const rows = await withWorkspace(ctx, async (db) => {
      const where: Prisma.CallWhereInput = { tenantId: ctx.workspaceId, startedAt: { gte: from, lt: to } };
      const [totals, missedByReason, daily] = await Promise.all([
        db.call.aggregate({ where, _count: { _all: true }, _sum: { durationS: true, creditsCharged: true, transferCreditsCharged: true } }),
        db.call.groupBy({ by: ['declineReason'], where: { ...where, status: 'declined' }, _count: { _all: true } }),
        db.$queryRaw<Array<{ day: string; calls: bigint; missed: bigint; seconds: number | null; credits: Prisma.Decimal | null }>>`
          -- started_at is a UTC wall time without a zone: pin it to UTC first, then read it in
          -- the workspace's zone. A bare AT TIME ZONE would treat the UTC value as local and
          -- shift it the wrong way (an 18:48 Toronto call landed on the next day's bar).
          SELECT to_char((started_at AT TIME ZONE 'UTC') AT TIME ZONE ${tenant.timezone}, 'YYYY-MM-DD') AS day,
                 count(*)                                                        AS calls,
                 count(*) FILTER (WHERE status = 'declined')                     AS missed,
                 coalesce(sum(duration_s), 0)                                    AS seconds,
                 -- D16: both legs of a transferred call are credits used.
                 coalesce(sum(credits_charged), 0) + coalesce(sum(transfer_credits_charged), 0) AS credits
            FROM calls
           WHERE tenant_id = ${ctx.workspaceId}::uuid
             AND started_at >= ${from} AND started_at < ${to}
           GROUP BY 1
           ORDER BY 1`,
        ]);
      const [answered, completed, test, channels] = await Promise.all([
        db.call.count({ where: { ...where, status: { not: 'declined' } } }),
        // The average is over calls that have a duration. `answered` includes the ones
        // still ringing or talking, whose duration_s is null until call_ended writes it;
        // dividing by those understates the average for as long as a call is live.
        db.call.count({ where: { ...where, status: { not: 'declined' }, durationS: { not: null } } }),
        db.call.count({ where: { ...where, isTest: true } }),
        // D17 §11.5: the website widget is its own channel in analytics. Real callers only.
        db.call.groupBy({
          by: ['channel'],
          where: { ...where, isTest: false },
          _count: { _all: true },
          _sum: { durationS: true, creditsCharged: true, transferCreditsCharged: true },
        }),
      ]);
      return { totals, missedByReason, daily, answered, completed, test, channels };
    });

    const total = rows.totals._count._all;
    const seconds = rows.totals._sum.durationS ?? 0;
    const missed = total - rows.answered;
    const missedBy = Object.fromEntries(
      rows.missedByReason.filter((r) => r.declineReason).map((r) => [r.declineReason as DeclineReason, r._count._all]),
    ) as Record<DeclineReason, number>;

    return {
      range: query.range,
      from: from.toISOString(),
      to: to.toISOString(),
      timezone: tenant.timezone,
      calls: { total, answered: rows.answered, missed, test: rows.test },
      minutes: round2(seconds / 60),
      credits_used: round2((rows.totals._sum.creditsCharged?.toNumber() ?? 0) + (rows.totals._sum.transferCreditsCharged?.toNumber() ?? 0)),
      avg_duration_s: rows.completed > 0 ? round2(seconds / rows.completed) : null,
      missed_by_reason: missedBy,
      by_day: rows.daily.map((d) => ({
        date: d.day,
        calls: Number(d.calls),
        missed: Number(d.missed),
        minutes: round2(Number(d.seconds ?? 0) / 60),
        credits: round2(Number(d.credits ?? 0)),
      })),
      by_channel: {
        phone: channelTotals(rows.channels.find((c) => c.channel === 'phone')),
        web: channelTotals(rows.channels.find((c) => c.channel === 'web')),
      },
    };
  }

  private filter(workspaceId: string, query: CallFilters): Prisma.CallWhereInput {
    const startedAt: Prisma.DateTimeNullableFilter = {};
    if (query.from) startedAt.gte = new Date(query.from);
    if (query.to) startedAt.lt = new Date(query.to);
    return {
      tenantId: workspaceId,
      ...(query.status ? { status: query.status === 'missed' ? 'declined' : query.status } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.agent_id ? { agentId: query.agent_id } : {}),
      ...(query.number_id ? { numberId: query.number_id } : {}),
      ...(query.is_test === undefined ? {} : { isTest: query.is_test }),
      ...(query.handled === undefined ? {} : { handledAt: query.handled ? { not: null } : null }),
      ...(Object.keys(startedAt).length ? { startedAt } : {}),
    };
  }
}

type SortColumn = 'startedAt' | 'durationS' | 'creditsCharged';

function sortColumn(sort: CallSort): SortColumn {
  return sort === 'started_at' ? 'startedAt' : sort === 'duration_s' ? 'durationS' : 'creditsCharged';
}

/**
 * The D2 sort as Prisma sees it. Whatever the column, `createdAt` and `id` follow so the
 * order is total — a keyset cursor resumes from one row, and two calls that started in
 * the same millisecond (or both have no duration yet) must not swap pages between
 * requests. Nulls go last in either direction: a call still ringing has no duration.
 */
function orderBy(sort: CallSort, order: SortOrder): Prisma.CallOrderByWithRelationInput[] {
  return [{ [sortColumn(sort)]: { sort: order, nulls: 'last' } }, { createdAt: order }, { id: order }];
}

/**
 * The rows after `position` in the order `orderBy()` produces, spelled out. Prisma's own
 * `cursor` compares the sort columns as a tuple, and a tuple comparison against NULL is
 * NULL in Postgres — so once the cursor row sat in the null tail (a missed call has no
 * duration and no credits) the next page came back empty while `total` said otherwise.
 * With nulls last: after a non-null value come the greater/lesser values, the equal ones
 * past the tiebreak, and then every null; after a null row come only the other null rows
 * past the tiebreak.
 */
function afterPosition(sort: CallSort, order: SortOrder, position: CursorRow): Prisma.CallWhereInput {
  const column = sortColumn(sort);
  const op = order === 'asc' ? 'gt' : 'lt';
  const tiebreak: Prisma.CallWhereInput = {
    OR: [{ createdAt: { [op]: position.createdAt } }, { createdAt: position.createdAt, id: { [op]: position.id } }],
  };
  const value = position[column];
  if (value === null) return { AND: [{ [column]: null }, tiebreak] };
  return { OR: [{ [column]: { [op]: value } }, { AND: [{ [column]: value }, tiebreak] }, { [column]: null }] };
}

function invalidCursor(): AppError {
  return new AppError('INVALID_CURSOR', 'That page link is no longer valid. Start from the first page.');
}

function toDetail(row: DetailRow, names: ReadonlyMap<string, string>): CallDetail {
  return {
    ...toSummary(row),
    transcript_text: row.transcriptText,
    transcript_json: row.transcriptJson ?? null,
    analysis_json: row.analysisJson ?? null,
    captured_checks: capturedChecks(row),
    transfer: row.transferStatus
      ? {
          status: row.transferStatus as TransferStatus,
          bridged_at: row.transferBridgedAt?.toISOString() ?? null,
          ended_at: row.transferEndedAt?.toISOString() ?? null,
          duration_s: row.transferDurationS,
          rate: row.transferRate?.toNumber() ?? null,
          credits_charged: row.transferCreditsCharged?.toNumber() ?? null,
        }
      : null,
    knowledge: knowledgeUseOf(row.kbRetrievals, row.kbHits, row.kbUsageJson, names),
  };
}

/**
 * The names of the sources a call's look-ups came from, read now: a source renamed since
 * the call shows its current name, and one deleted since shows no name (and no link).
 */
async function sourceNames(db: Prisma.TransactionClient, row: DetailRow, workspaceId: string): Promise<Map<string, string>> {
  const ids = storedSourceIds(row.kbUsageJson);
  if (!ids.length) return new Map();
  const rows = await db.knowledgeSource.findMany({ where: { id: { in: ids }, tenantId: workspaceId }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Every captured phone number, checked against the caller's own words (`captured-phones.ts`). */
function capturedChecks(row: DetailRow): CallDetail['captured_checks'] {
  const analysis = row.analysisJson;
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return [];
  return checkCapturedPhones({
    captured: (analysis as Record<string, unknown>).custom_analysis_data,
    callerTurns: callerUtterances(row.transcriptJson, row.transcriptText),
    // Our end of an outbound leg is from_number; the caller is only ever the other party.
    callerId: row.direction === 'outbound' ? row.toNumber : row.fromNumber,
    regions: phoneRegions(row.tenant.country, [row.agent?.primaryLanguage, ...(row.agent?.languages ?? [])]),
  });
}

/** `analysis_json.user_sentiment`, when the platform wrote one. */
function sentimentOf(analysis: Prisma.JsonValue | null): string | null {
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return null;
  const value = (analysis as Record<string, unknown>).user_sentiment;
  return typeof value === 'string' && value.trim() ? value : null;
}

function toSummary(row: CallRow): CallSummary {
  return {
    id: row.id,
    agent_id: row.agentId,
    agent_version: row.agentVersion,
    number_id: row.numberId,
    channel: row.channel,
    direction: row.direction,
    is_test: row.isTest,
    from_number: row.fromNumber,
    to_number: row.toNumber,
    started_at: row.startedAt?.toISOString() ?? null,
    ended_at: row.endedAt?.toISOString() ?? null,
    duration_s: row.durationS,
    disconnection_reason: row.disconnectionReason,
    tier: row.tier,
    rate: row.rate.toNumber(),
    config_version: row.configVersion,
    credits_charged: row.creditsCharged?.toNumber() ?? null,
    transfer_credits_charged: row.transferCreditsCharged?.toNumber() ?? null,
    // §13.9: a declined call is "Missed" to the customer; `declined` is a storage word.
    status: (row.status === 'declined' ? 'missed' : row.status) as CallDisplayStatus,
    decline_reason: row.declineReason,
    outcome: row.outcome,
    handled_at: row.handledAt?.toISOString() ?? null,
    note: row.note,
    has_recording: Boolean(row.recordingUrl),
    sentiment: sentimentOf(row.analysisJson),
    created_at: row.createdAt.toISOString(),
  };
}

/** A Retell signed URL carries its own expiry; anything we cannot read is treated as stale. */
function isFresh(url: string): boolean {
  try {
    const parsed = new URL(url);
    const expires = parsed.searchParams.get('X-Amz-Expires') ?? parsed.searchParams.get('Expires');
    const date = parsed.searchParams.get('X-Amz-Date');
    if (expires && date) {
      const signedAt = Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
      if (Number.isFinite(signedAt)) return signedAt + Number(expires) * 1000 > Date.now() + 60_000;
    }
    if (expires && !date) return Number(expires) * 1000 > Date.now() + 60_000;
    // No expiry in the URL: nothing says it is stale.
    return true;
  } catch {
    return false;
  }
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function channelTotals(
  row: { _count: { _all: number }; _sum: { durationS: number | null; creditsCharged: Prisma.Decimal | null; transferCreditsCharged: Prisma.Decimal | null } } | undefined,
): { calls: number; minutes: number; credits: number } {
  if (!row) return { calls: 0, minutes: 0, credits: 0 };
  return {
    calls: row._count._all,
    minutes: round2((row._sum.durationS ?? 0) / 60),
    credits: round2((row._sum.creditsCharged?.toNumber() ?? 0) + (row._sum.transferCreditsCharged?.toNumber() ?? 0)),
  };
}
