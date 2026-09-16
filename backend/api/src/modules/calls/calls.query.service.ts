import { Injectable, Logger } from '@nestjs/common';
import { Prisma, withWorkspace } from '@portal/db';
import type {
  CallDetail,
  CallDisplayStatus,
  CallPatch,
  CallSummary,
  CallsQuery,
  DeclineReason,
  Page,
  StatsQuery,
  StatsResponse,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import type { WorkspaceContext } from '../auth';
import { RetellGateway } from '../retell';
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
  status: true,
  declineReason: true,
  outcome: true,
  handledAt: true,
  note: true,
  recordingUrl: true,
  createdAt: true,
} satisfies Prisma.CallSelect;

const DETAIL_SELECT = { ...CALL_SELECT, transcriptText: true, transcriptJson: true, analysisJson: true } satisfies Prisma.CallSelect;

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
  ) {}

  async list(ctx: WorkspaceContext, query: CallsQuery): Promise<Page<CallSummary>> {
    const rows = await withWorkspace(ctx, (db) =>
      db.call.findMany({
        ...cursorArgs(query),
        where: this.filter(ctx.workspaceId, query),
        // started_at is null only on a row that has not started; createdAt breaks the tie
        // and keeps the ordering total, which a keyset cursor needs to be stable.
        orderBy: [{ startedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
        select: CALL_SELECT,
      }),
    );
    const page = toPage(rows, query);
    return { next_cursor: page.next_cursor, items: page.items.map(toSummary) };
  }

  async get(ctx: WorkspaceContext, callId: string): Promise<CallDetail> {
    const row = await withWorkspace(ctx, (db) =>
      db.call.findFirst({ where: { id: callId, tenantId: ctx.workspaceId }, select: DETAIL_SELECT }),
    );
    if (!row) throw AppError.notFound('Call');
    return {
      ...toSummary(row),
      transcript_text: row.transcriptText,
      transcript_json: row.transcriptJson ?? null,
      analysis_json: row.analysisJson ?? null,
    };
  }

  /** D2 detail actions: mark handled, leave a note. */
  async patch(ctx: WorkspaceContext, callId: string, body: CallPatch): Promise<CallDetail> {
    const updated = await withWorkspace(ctx, async (db) => {
      const exists = await db.call.findFirst({ where: { id: callId, tenantId: ctx.workspaceId }, select: { id: true, handledAt: true } });
      if (!exists) return null;
      return db.call.update({
        where: { id: callId },
        data: {
          ...(body.handled === undefined ? {} : { handledAt: body.handled ? (exists.handledAt ?? new Date()) : null }),
          ...(body.note === undefined ? {} : { note: body.note }),
        },
        select: DETAIL_SELECT,
      });
    });
    if (!updated) throw AppError.notFound('Call');
    return {
      ...toSummary(updated),
      transcript_text: updated.transcriptText,
      transcript_json: updated.transcriptJson ?? null,
      analysis_json: updated.analysisJson ?? null,
    };
  }

  /**
   * `GET /calls/:id/recording` → a signed link to our own streaming route, valid one hour
   * (§17). The Retell URL is never handed to the browser: it is a bearer credential for
   * audio we are custodian of, and it outlives any check we would do here.
   */
  async recordingLink(ctx: WorkspaceContext, callId: string, origin: string): Promise<{ url: string; expires_at: string }> {
    const row = await withWorkspace(ctx, (db) =>
      db.call.findFirst({ where: { id: callId, tenantId: ctx.workspaceId }, select: { id: true, recordingUrl: true } }),
    );
    if (!row) throw AppError.notFound('Call');
    if (!row.recordingUrl) throw AppError.notFound('Recording');
    const { token, expiresAt } = this.signer.sign({ callId, workspaceId: ctx.workspaceId });
    return { url: `${origin.replace(/\/+$/, '')}/calls/${encodeURIComponent(callId)}/recording/stream?token=${token}`, expires_at: expiresAt.toISOString() };
  }

  /**
   * Resolves a signed token to a playable Retell URL. Called by the @Public() streaming
   * route: the token is the credential, so this re-checks that it names this call and
   * that the recording still exists, and never trusts the path alone.
   *
   * Retell's stored URL is itself signed and expires (`opt_in_signed_url`), so a stale one
   * is refreshed from `get-call` — outside any transaction.
   */
  async resolveRecording(callId: string, token: string | undefined): Promise<{ url: string }> {
    const claims = this.signer.verify(token);
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
        db.call.aggregate({ where, _count: { _all: true }, _sum: { durationS: true, creditsCharged: true } }),
        db.call.groupBy({ by: ['declineReason'], where: { ...where, status: 'declined' }, _count: { _all: true } }),
        db.$queryRaw<Array<{ day: string; calls: bigint; missed: bigint; seconds: number | null; credits: Prisma.Decimal | null }>>`
          SELECT to_char(date_trunc('day', started_at AT TIME ZONE ${tenant.timezone}), 'YYYY-MM-DD') AS day,
                 count(*)                                                        AS calls,
                 count(*) FILTER (WHERE status = 'declined')                     AS missed,
                 coalesce(sum(duration_s), 0)                                    AS seconds,
                 coalesce(sum(credits_charged), 0)                               AS credits
            FROM calls
           WHERE tenant_id = ${ctx.workspaceId}::uuid
             AND started_at >= ${from} AND started_at < ${to}
           GROUP BY 1
           ORDER BY 1`,
        ]);
      const [answered, completed, test] = await Promise.all([
        db.call.count({ where: { ...where, status: { not: 'declined' } } }),
        // The average is over calls that have a duration. `answered` includes the ones
        // still ringing or talking, whose duration_s is null until call_ended writes it;
        // dividing by those understates the average for as long as a call is live.
        db.call.count({ where: { ...where, status: { not: 'declined' }, durationS: { not: null } } }),
        db.call.count({ where: { ...where, isTest: true } }),
      ]);
      return { totals, missedByReason, daily, answered, completed, test };
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
      credits_used: round2(rows.totals._sum.creditsCharged?.toNumber() ?? 0),
      avg_duration_s: rows.completed > 0 ? round2(seconds / rows.completed) : null,
      missed_by_reason: missedBy,
      by_day: rows.daily.map((d) => ({
        date: d.day,
        calls: Number(d.calls),
        missed: Number(d.missed),
        minutes: round2(Number(d.seconds ?? 0) / 60),
        credits: round2(Number(d.credits ?? 0)),
      })),
    };
  }

  private filter(workspaceId: string, query: CallsQuery): Prisma.CallWhereInput {
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
      ...(Object.keys(startedAt).length ? { startedAt } : {}),
    };
  }
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
    // §13.9: a declined call is "Missed" to the customer; `declined` is a storage word.
    status: (row.status === 'declined' ? 'missed' : row.status) as CallDisplayStatus,
    decline_reason: row.declineReason,
    outcome: row.outcome,
    handled_at: row.handledAt?.toISOString() ?? null,
    note: row.note,
    has_recording: Boolean(row.recordingUrl),
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

/**
 * `today` and the `Nd` ranges are whole local days in the workspace timezone, so "today"
 * means the customer's today and not UTC's.
 */
export function resolveWindow(query: StatsQuery, timeZone: string): { from: Date; to: Date } {
  if (query.range === 'custom') return { from: new Date(query.from!), to: new Date(query.to!) };
  const now = new Date();
  const to = new Date(now.getTime() + 1_000);
  const days = query.range === 'today' ? 1 : query.range === '7d' ? 7 : 30;
  return { from: startOfLocalDay(now, timeZone, days - 1), to };
}

/** Midnight, `daysBack` local days ago, expressed as an instant. */
function startOfLocalDay(now: Date, timeZone: string, daysBack: number): Date {
  let offsetMs = 0;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value])) as Record<string, string>;
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    offsetMs = asUtc - Math.floor(now.getTime() / 1000) * 1000;
  } catch {
    offsetMs = 0;
  }
  const local = new Date(now.getTime() + offsetMs);
  local.setUTCHours(0, 0, 0, 0);
  local.setUTCDate(local.getUTCDate() - daysBack);
  return new Date(local.getTime() - offsetMs);
}
