import { Injectable, Logger } from '@nestjs/common';
import { withWorkspace, type WorkspaceDb } from '@portal/db';
import { callsExportRequest } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { WorkspaceContext } from '../auth';
import { CallsQueryService } from '../calls';
import { RedisCache, redisKeys } from '../redis';
import { WalletService } from '../wallet';
import {
  AUDIT_COLUMNS,
  EXPORT_SECTION_MAX_ROWS,
  EXPORT_VERSIONS_MAX_ROWS,
  INVITE_COLUMNS,
  INVOICE_COLUMNS,
  KNOWLEDGE_COLUMNS,
  MEMBER_COLUMNS,
  NUMBER_COLUMNS,
  PURCHASE_COLUMNS,
  agentJson,
  auditLine,
  inviteLine,
  invoiceLine,
  knowledgeLine,
  memberLine,
  numberLine,
  purchaseLine,
  versionJson,
  workspaceJson,
} from './export-sections';
import type { ZipEntry } from './zip-stream';

/** Exports a workspace may start per hour. Each one reads every section of the workspace. */
export const DATA_EXPORTS_PER_HOUR = 5;
const WINDOW_S = 3_600;
/** Rows per `withWorkspace` round trip; versions carry whole prompts, so they come in smaller batches. */
const BATCH = 500;
const VERSION_BATCH = 50;
const CALL_AND_LEDGER_MAX_ROWS = 10_000;

interface Position {
  id: string;
  createdAt: Date;
}

interface Tally {
  file: string;
  rows: number;
  max: number;
}

const ASC = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
const DESC = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
const afterAsc = (p: Position) => ({ OR: [{ createdAt: { gt: p.createdAt } }, { createdAt: p.createdAt, id: { gt: p.id } }] });
const afterDesc = (p: Position) => ({ OR: [{ createdAt: { lt: p.createdAt } }, { createdAt: p.createdAt, id: { lt: p.id } }] });

/**
 * D6 "Export all data" (QA-081, spec p. 39, §17): `POST /workspace/export` answers a zip
 * of the workspace's own data, streamed as it is read.
 *
 * Synchronous, not the spec's "async zip": there is no object storage configured for a
 * job to leave a file in (no R2 code exists), and a link that cannot be fetched is worse
 * than a download. What makes a synchronous answer safe is that nothing is ever held:
 * every section is capped (`EXPORT_SECTION_MAX_ROWS`, the call and ledger exports' 10 000,
 * `EXPORT_VERSIONS_MAX_ROWS`), read in keyset batches each in its own short
 * `withWorkspace` (no connection held while the client downloads, no network I/O inside
 * one — ADR 0006), deflated by `zipStream` with backpressure from the HTTP socket, and
 * started at most `DATA_EXPORTS_PER_HOUR` times an hour per workspace. `manifest.json`,
 * written last, says how many rows each file holds and which hit their cap.
 */
@Injectable()
export class WorkspaceExportService {
  private readonly log = new Logger(WorkspaceExportService.name);

  constructor(
    private readonly calls: CallsQueryService,
    private readonly wallet: WalletService,
    private readonly cache: RedisCache,
  ) {}

  /**
   * Counts the export against the hourly budget and records it — a `data_requests` row
   * (`export`, executed now) and an `audit_log` row, in one transaction — before a byte
   * is sent, so a refusal is still an ordinary JSON error. Redis silent = allow, like
   * every other budget on the API.
   */
  async start(ctx: WorkspaceContext): Promise<{ requestId: string; at: Date }> {
    const used = await this.cache.increment(redisKeys.dataExportWindow(ctx.workspaceId), WINDOW_S);
    if (used !== null && used > DATA_EXPORTS_PER_HOUR) {
      throw new AppError('RATE_LIMITED', `You can export this workspace's data ${DATA_EXPORTS_PER_HOUR} times an hour. Try again later.`);
    }
    const at = new Date();
    const requestId = await withWorkspace(ctx, async (db) => {
      const request = await db.dataRequest.create({
        data: { tenantId: ctx.workspaceId, type: 'export', requestedBy: ctx.userId, executedAt: at, createdAt: at },
        select: { id: true },
      });
      await db.auditLog.create({
        data: {
          tenantId: ctx.workspaceId,
          actorUserId: ctx.userId,
          action: 'workspace.data_exported',
          targetType: 'workspace',
          targetId: ctx.workspaceId,
          ip: ctx.ip ?? null,
          metaJson: { data_request_id: request.id, ...(ctx.requestId ? { request_id: ctx.requestId } : {}) },
        },
      });
      return request.id;
    });
    this.log.log(`data export ${requestId} started by ${ctx.userId} in ${ctx.workspaceId}`);
    return { requestId, at };
  }

  /** The archive's entries, each read only when the zip writer reaches it. */
  *entries(ctx: WorkspaceContext, started: { requestId: string; at: Date }): Generator<ZipEntry> {
    const ws = ctx.workspaceId;
    const tallies: Tally[] = [];
    const tally = (file: string, max: number): Tally => {
      const t = { file, rows: 0, max };
      tallies.push(t);
      return t;
    };

    yield { name: 'workspace.json', content: this.workspaceFile(ctx) };

    yield {
      name: 'members.csv',
      content: csvFile(MEMBER_COLUMNS, this.rows(ctx, tally('members.csv', EXPORT_SECTION_MAX_ROWS), BATCH, (db, after, take) =>
        db.membership.findMany({
          where: after ? { AND: [{ tenantId: ws }, afterAsc(after)] } : { tenantId: ws },
          orderBy: ASC,
          take,
          include: { user: { select: { name: true, email: true } } },
        }),
      ), memberLine),
    };

    yield {
      name: 'invites.csv',
      content: csvFile(INVITE_COLUMNS, this.rows(ctx, tally('invites.csv', EXPORT_SECTION_MAX_ROWS), BATCH, (db, after, take) =>
        db.invite.findMany({
          where: after ? { AND: [{ tenantId: ws }, afterAsc(after)] } : { tenantId: ws },
          orderBy: ASC,
          take,
          select: { id: true, email: true, role: true, invitedBy: true, createdAt: true, expiresAt: true, acceptedAt: true },
        }),
      ), inviteLine),
    };

    // Deleted agents are left out, like every customer read of `agents` (CLAUDE.md, append-only
    // tables): their calls stay in calls.csv under the agent id.
    const liveAgent = { tenantId: ws, deletedAt: null };
    yield {
      name: 'agents.json',
      content: jsonArray(this.rows(ctx, tally('agents.json', EXPORT_SECTION_MAX_ROWS), BATCH, (db, after, take) =>
        db.agent.findMany({ where: after ? { AND: [liveAgent, afterAsc(after)] } : liveAgent, orderBy: ASC, take }),
      ), agentJson),
    };

    const versionOf = { agent: liveAgent };
    yield {
      name: 'agent_versions.json',
      content: jsonArray(this.rows(ctx, tally('agent_versions.json', EXPORT_VERSIONS_MAX_ROWS), VERSION_BATCH, (db, after, take) =>
        db.agentVersion.findMany({
          where: after ? { AND: [versionOf, afterAsc(after)] } : versionOf,
          orderBy: ASC,
          take,
          select: {
            id: true,
            agentId: true,
            versionNo: true,
            source: true,
            briefJson: true,
            settingsJson: true,
            promptText: true,
            greeting: true,
            closing: true,
            analysisSchemaJson: true,
            feedbackText: true,
            publishedAt: true,
            createdAt: true,
          },
        }),
      ), versionJson),
    };

    yield {
      name: 'knowledge_sources.csv',
      content: csvFile(KNOWLEDGE_COLUMNS, this.rows(ctx, tally('knowledge_sources.csv', EXPORT_SECTION_MAX_ROWS), BATCH, (db, after, take) =>
        db.knowledgeSource.findMany({
          where: after ? { AND: [{ tenantId: ws }, afterAsc(after)] } : { tenantId: ws },
          orderBy: ASC,
          take,
          // Never `payload` (the bytes) or `sync_json` (the platform's side of the sync).
          select: { id: true, agentId: true, type: true, role: true, name: true, url: true, contentType: true, status: true, sizeBytes: true, error: true, syncedAt: true, createdAt: true },
        }),
      ), knowledgeLine),
    };

    yield {
      name: 'numbers.csv',
      content: csvFile(NUMBER_COLUMNS, this.rows(ctx, tally('numbers.csv', EXPORT_SECTION_MAX_ROWS), BATCH, (db, after, take) =>
        db.phoneNumber.findMany({
          where: after ? { AND: [{ tenantId: ws }, afterAsc(after)] } : { tenantId: ws },
          orderBy: ASC,
          take,
          // Never `inbound_token`, `retell_meta_json`, `carrier` or anything SIP.
          select: {
            id: true,
            e164: true,
            nickname: true,
            type: true,
            country: true,
            areaCode: true,
            requestedAreaCode: true,
            tollFree: true,
            status: true,
            agentId: true,
            hoursMode: true,
            hoursOverrideJson: true,
            transferTargetsJson: true,
            transferFailMessage: true,
            allowedCountries: true,
            blocklist: true,
            forwardingFrom: true,
            forwardingStatus: true,
            createdAt: true,
            releasedAt: true,
          },
        }),
      ), numberLine),
    };

    // The D2 export, unfiltered: the same columns, cap and batching as `POST /calls/export`.
    const calls = tally('calls.csv', CALL_AND_LEDGER_MAX_ROWS);
    yield { name: 'calls.csv', content: countLines(this.calls.exportCsv(ctx, callsExportRequest.parse({})), calls) };

    const ledger = tally('credit_history.csv', CALL_AND_LEDGER_MAX_ROWS);
    yield { name: 'credit_history.csv', content: countLines(this.wallet.exportLedgerCsv(ctx, {}), ledger) };

    yield {
      name: 'purchases.csv',
      content: csvFile(PURCHASE_COLUMNS, this.rows(ctx, tally('purchases.csv', EXPORT_SECTION_MAX_ROWS), BATCH, (db, after, take) =>
        db.purchase.findMany({
          where: after ? { AND: [{ tenantId: ws }, afterAsc(after)] } : { tenantId: ws },
          orderBy: ASC,
          take,
          select: { id: true, packId: true, credits: true, amountCents: true, currency: true, status: true, isAutoTopup: true, promoCode: true, createdAt: true },
        }),
      ), purchaseLine),
    };

    yield {
      name: 'invoices.csv',
      content: csvFile(INVOICE_COLUMNS, this.rows(ctx, tally('invoices.csv', EXPORT_SECTION_MAX_ROWS), BATCH, (db, after, take) =>
        db.invoice.findMany({
          where: after ? { AND: [{ tenantId: ws }, afterAsc(after)] } : { tenantId: ws },
          orderBy: ASC,
          take,
          select: {
            id: true,
            number: true,
            purchaseId: true,
            status: true,
            amountCents: true,
            amountPaidCents: true,
            currency: true,
            hostedUrl: true,
            pdfUrl: true,
            finalizedAt: true,
            paidAt: true,
            voidedAt: true,
            createdAt: true,
          },
        }),
      ), invoiceLine),
    };

    // Newest first, like D6's audit tab: the cap keeps the most recent 10 000.
    yield {
      name: 'audit_log.csv',
      content: csvFile(AUDIT_COLUMNS, this.rows(ctx, tally('audit_log.csv', EXPORT_SECTION_MAX_ROWS), BATCH, (db, after, take) =>
        db.auditLog.findMany({
          where: after ? { AND: [{ tenantId: ws }, afterDesc(after)] } : { tenantId: ws },
          orderBy: DESC,
          take,
          include: { actor: { select: { email: true } } },
        }),
      ), auditLine),
    };

    // Last, so it can count what went before it.
    yield {
      name: 'manifest.json',
      content: (function* () {
        yield `${JSON.stringify(
          {
            workspace_id: ws,
            export_id: started.requestId,
            generated_at: started.at.toISOString(),
            files: [
              { name: 'workspace.json', rows: 1, truncated: false },
              ...tallies.map((t) => ({ name: t.file, rows: t.rows, truncated: t.rows >= t.max })),
            ],
            note: 'Each file holds at most the number of rows shown; a file marked truncated holds the newest (calls, credit history, audit log) or the first rows. Ask support for anything beyond it.',
          },
          null,
          2,
        )}\n`;
      })(),
    };
  }

  private async *workspaceFile(ctx: WorkspaceContext): AsyncGenerator<string> {
    const row = await withWorkspace(ctx, (db) => db.tenant.findUnique({ where: { id: ctx.workspaceId } }));
    if (!row) throw AppError.notFound('Workspace');
    yield `${JSON.stringify(workspaceJson(row), null, 2)}\n`;
  }

  /**
   * One section's rows, `batch` at a time, each batch its own `withWorkspace` — RLS scopes
   * every read, no transaction outlives a batch — resumed by keyset on (`created_at`, `id`)
   * and stopped at the tally's cap.
   */
  private async *rows<R extends Position>(
    ctx: WorkspaceContext,
    tally: Tally,
    batch: number,
    read: (db: WorkspaceDb, after: Position | null, take: number) => Promise<R[]>,
  ): AsyncGenerator<R> {
    let after: Position | null = null;
    while (tally.rows < tally.max) {
      const take = Math.min(batch, tally.max - tally.rows);
      const position = after;
      const rows: R[] = await withWorkspace(ctx, (db) => read(db, position, take));
      for (const row of rows) {
        tally.rows += 1;
        yield row;
      }
      if (rows.length < take) return;
      const last = rows[rows.length - 1]!;
      after = { id: last.id, createdAt: last.createdAt };
    }
  }
}

async function* csvFile<R>(columns: readonly string[], rows: AsyncIterable<R>, line: (row: R) => string): AsyncGenerator<string> {
  yield `${columns.join(',')}\r\n`;
  for await (const row of rows) yield line(row);
}

async function* jsonArray<R>(rows: AsyncIterable<R>, shape: (row: R) => unknown): AsyncGenerator<string> {
  let first = true;
  yield '[';
  for await (const row of rows) {
    yield `${first ? '\n' : ',\n'}${JSON.stringify(shape(row))}`;
    first = false;
  }
  yield first ? ']\n' : '\n]\n';
}

/** A CSV generator from another module yields its header, then one line per row. */
async function* countLines(lines: AsyncIterable<string>, tally: Tally): AsyncGenerator<string> {
  let header = true;
  for await (const line of lines) {
    if (header) header = false;
    else tally.rows += 1;
    yield line;
  }
}
