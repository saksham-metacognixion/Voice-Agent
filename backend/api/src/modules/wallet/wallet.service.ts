import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb, isDuplicateCallDebit, isDuplicateRentalDebit, withWorkspace, type LedgerReason } from '@portal/db';
import type {
  AutoTopup,
  CreditLotResponse,
  LedgerEntryResponse,
  LedgerQuery,
  Page,
  WalletResponse,
} from '@portal/schemas';
import { autoTopup as autoTopupSchema } from '@portal/schemas';
import { cursorArgs, toPage } from '../../common/pagination';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { RedisCache, redisKeys } from '../redis';
import { allocateFifo, lotRemainingAfterSettling, roundCredits } from './fifo';

type Tx = Prisma.TransactionClient;

/** What a ledger write returns, as plain numbers. */
export interface LedgerWrite {
  id: string;
  delta: number;
  balance_after: number;
  reason: LedgerReason;
  ref_id: string | null;
  lot_id: string | null;
  /** True when this call was already debited and nothing was written (§14.2 idempotency). */
  duplicate: boolean;
}

export interface GrantInput {
  credits: number;
  reason: Extract<LedgerReason, 'trial' | 'purchase' | 'topup' | 'adjustment' | 'refund'>;
  /** When the lot lapses. Required for anything that creates a lot. */
  expiresAt: Date;
  purchaseId?: string;
  refType?: string;
  refId?: string;
  /** pricing_configs.version whose wallet_policy set the expiry. */
  policyVersion?: number;
}

/**
 * A FIFO draw-down across live lots. `expiry` is deliberately not a debit reason: a lapsed
 * lot is written off by `WalletTx.expireLot`, which empties *that* lot rather than drawing
 * from the ones still open.
 */
export interface DebitInput {
  credits: number;
  /** `refund` (D13, SA9): the credits a refunded purchase granted are drawn back, `ref_id` = the refund id. */
  reason: Extract<LedgerReason, 'call' | 'rental' | 'kb' | 'adjustment' | 'refund'>;
  refType?: string;
  refId?: string;
}

/** A listener for "the balance of this workspace changed" — D4 wires SSE, alerts, auto top-up. */
export type LedgerListener = (event: { workspaceId: string; write: LedgerWrite }) => void | Promise<void>;

/**
 * How long `bal:{ws}` may be believed without a writer touching it. The key is a cache,
 * never the truth, so anything that can leave a wrong value behind — a Redis restored
 * from an old snapshot, a write that lost its race with an outage — has to age out rather
 * than sit there forever. A stale *high* balance is the dangerous direction: the §13.9
 * inbound check would let a workspace spend credits it does not have. On the miss,
 * `balance()` rebuilds from the ledger and the inbound path does what ADR 0003 §12 says.
 */
export const BALANCE_TTL_S = 3_600;

/**
 * The wallet module (§5.4, §14, §15): the **only** code that writes `credit_ledger` or
 * `credit_lots`. Everything billable goes through here — purchases, trial grants, call
 * debits, rentals, expiry, staff adjustments — so there is one place where FIFO, the
 * grace overdraft, idempotency and the balance cache are right.
 *
 * Model
 *   - Balance = Σ credit_ledger.delta. Cached at `bal:{ws}` (2 dp, string); rebuilt from
 *     the ledger whenever the cache is missing or disagrees. The ledger is the truth.
 *   - One ledger row per movement. A debit that spans several lots is still one row
 *     (the partial unique index on `ref_id WHERE reason='call'` needs it to be); the lots
 *     are drawn down FIFO by `expires_at` and `lot_id` names the first lot drawn.
 *   - A debit larger than every open lot leaves the lots at 0 and the balance negative.
 *     That is the §5.4 grace overdraft; the *next* grant settles it out of its lot first.
 *   - Every write runs under a per-workspace transaction-scoped advisory lock, so two
 *     concurrent debits cannot both read the same balance, and `bal:{ws}` is published
 *     while that lock is still held so the cache can only move in commit order. The lock
 *     is on the workspace, never global: workspaces never wait on each other.
 *   - A lapsed lot is written off before any movement, so credits cannot be charged once
 *     as an overdraft here and once again by the credit-expiry job.
 *
 * Connections: writes run on `adminDb` with an explicit tenant id — they come from
 * webhooks, jobs and staff, none of which has a customer request context. Customer reads
 * (`summary`, `lots`, `ledger`) run inside `withWorkspace(ctx)` so RLS is the second guard.
 */
@Injectable()
export class WalletService {
  private readonly log = new Logger(WalletService.name);
  private readonly listeners: LedgerListener[] = [];

  constructor(
    private readonly cache: RedisCache,
    private readonly config: PlatformConfigService,
  ) {}

  /** D4: SSE `wallet` topic, low-balance alerts, auto top-up trigger. */
  onLedgerWrite(listener: LedgerListener): void {
    this.listeners.push(listener);
  }

  // ------------------------------------------------------------------ balance

  /** `bal:{ws}`, else rebuilt from the ledger. Never throws on a Redis outage. */
  async balance(workspaceId: string): Promise<number> {
    const cached = await this.cache.get(redisKeys.balance(workspaceId));
    if (cached !== null) {
      const n = Number(cached);
      if (Number.isFinite(n)) return n;
    }
    return this.rebuildBalance(workspaceId);
  }

  /**
   * Σ delta from the ledger, written back to the cache. The mismatch/miss repair path.
   *
   * Takes the wallet lock for the few milliseconds it needs, and for the same reason the
   * writers publish inside it: a rebuild that summed *before* a concurrent debit committed
   * and published *after* it would put the pre-debit balance back — stale-high, which is
   * the one direction the §13.9 inbound check cannot tolerate. Under the lock the sum
   * waits for the in-flight writer and lands its committed value.
   */
  async rebuildBalance(workspaceId: string): Promise<number> {
    return adminDb.$transaction(
      async (tx) => {
        await lockWallet(tx, workspaceId);
        const balance = await this.sumLedger(tx, workspaceId);
        await this.cacheBalance(workspaceId, balance);
        return balance;
      },
      { timeout: 5_000, maxWait: 5_000 },
    );
  }

  /** The one place `bal:{ws}` is written, so the TTL is never forgotten. */
  private cacheBalance(workspaceId: string, balance: number): Promise<boolean> {
    return this.cache.set(redisKeys.balance(workspaceId), balance.toFixed(2), BALANCE_TTL_S);
  }

  private async sumLedger(tx: Tx, workspaceId: string): Promise<number> {
    const agg = await tx.creditLedger.aggregate({ where: { tenantId: workspaceId }, _sum: { delta: true } });
    return roundCredits(agg._sum.delta?.toNumber() ?? 0);
  }

  // ------------------------------------------------------------------ writes

  /**
   * Runs `fn` inside one transaction holding this workspace's wallet lock, then updates
   * the cache and notifies listeners for every ledger row `fn` wrote. Billing uses this to
   * mark a purchase paid and grant its credits atomically.
   */
  async withWallet<T>(workspaceId: string, fn: (tx: Tx, wallet: WalletTx) => Promise<T>, options: { timeout?: number } = {}): Promise<T> {
    const writes: LedgerWrite[] = [];
    let published = false;
    try {
      const result = await adminDb.$transaction(
        async (tx) => {
          await lockWallet(tx, workspaceId);
          const out = await fn(tx, new WalletTx(this, tx, workspaceId, writes));
          // Still inside the transaction, so still holding this workspace's wallet lock:
          // the next writer cannot even start until we commit, which is the only thing
          // that keeps `bal:{ws}` in commit order. Publishing after the commit instead
          // let two concurrent debits land backwards and leave a stale-high balance the
          // §13.9 inbound check would then spend against. This is the one piece of I/O
          // allowed inside a wallet transaction: Redis is compose-local, `RedisCache` is
          // bounded by its own timeout and never throws, so it cannot stall the pool.
          const last = writes.filter((w) => !w.duplicate).at(-1);
          if (last) published = await this.cacheBalance(workspaceId, last.balance_after);
          return out;
        },
        { timeout: options.timeout ?? 10_000, maxWait: 5_000 },
      );
      await this.notifyListeners(workspaceId, writes);
      return result;
    } catch (error) {
      // The transaction rolled back after we published its balance. Drop the key rather
      // than guess at the truth: `balance()` rebuilds it from the ledger on the next read.
      if (published) await this.cache.del(redisKeys.balance(workspaceId));
      throw error;
    }
  }

  /** Adds credits, creating a lot. Purchases, trial, top-ups, positive adjustments, refund reversals. */
  grant(workspaceId: string, input: GrantInput): Promise<LedgerWrite> {
    return this.withWallet(workspaceId, (_tx, wallet) => wallet.grant(input));
  }

  /**
   * Removes credits FIFO across open lots. Calls, rentals, KB fees, negative adjustments.
   *
   * Nothing here stops the balance going below −grace: for a call that is correct (the
   * §13.9 inbound check already bounded it via `max_call_duration_ms`, and a call in
   * progress is never cut for money), so the wallet cannot tell a legitimate overdraft
   * from a careless one. A recurring charge (§5.3 rental, KB fee) must check `balance()`
   * first and take the §5.3 "release after N days at zero" path instead of debiting into
   * an unbounded negative.
   */
  debit(workspaceId: string, input: DebitInput): Promise<LedgerWrite> {
    return this.withWallet(workspaceId, (_tx, wallet) => wallet.debit(input));
  }

  /**
   * The §14.2 call debit: idempotent on `call_id`, so a replayed `call_ended` returns the
   * original row with `duplicate: true` and moves nothing. The guarantee is the partial
   * unique index in Postgres; the pre-check only saves an exception on the common replay.
   */
  debitCall(workspaceId: string, callId: string, credits: number): Promise<LedgerWrite> {
    return this.debit(workspaceId, { credits, reason: 'call', refType: 'call', refId: callId });
  }

  /**
   * Runs one wallet operation inside a transaction **the caller owns**.
   *
   * `withWallet` opens its own transaction, which is right for everything that is only a
   * wallet movement. Workspace creation is not: §13.2 wants the tenant, the owner
   * membership, the notification defaults, the audit row *and* the trial grant to be one
   * atomic step, and nesting `adminDb.$transaction` inside another would take a second
   * pooled connection and deadlock against the advisory lock the outer one may hold.
   *
   * So this is the same body with the transaction supplied: it takes the per-workspace
   * wallet lock on the caller's `tx`, runs `fn`, and publishes `bal:{ws}` inside it, in
   * commit order, exactly as `withWallet` does (ADR 0010 §3). What it cannot do is notify
   * listeners — those must not fire before the caller commits — so it hands the writes
   * back and the caller calls `notify()` afterwards.
   *
   * There is still exactly one place that writes `credit_ledger`: this class.
   */
  async withWalletTx<T>(tx: Tx, workspaceId: string, fn: (wallet: WalletTx) => Promise<T>): Promise<{ result: T; writes: LedgerWrite[] }> {
    const writes: LedgerWrite[] = [];
    await lockWallet(tx, workspaceId);
    const result = await fn(new WalletTx(this, tx, workspaceId, writes));
    const last = writes.filter((w) => !w.duplicate).at(-1);
    if (last) await this.cacheBalance(workspaceId, last.balance_after);
    return { result, writes };
  }

  /**
   * Fires the ledger listeners for writes made through `withWalletTx`. Call it **after**
   * the owning transaction commits: a `wallet` SSE frame for a balance that then rolled
   * back is a number the customer can see and the database cannot.
   */
  async notify(workspaceId: string, writes: LedgerWrite[]): Promise<void> {
    await this.notifyListeners(workspaceId, writes);
  }

  /** §5.4 free trial. Expiry comes from the policy current now, recorded on the lot. */
  async grantTrial(workspaceId: string): Promise<LedgerWrite | null> {
    const { policy, configVersion } = await this.config.walletPolicy();
    if (policy.trial_credits <= 0) return null;
    return this.withWallet(workspaceId, (tx, wallet) => this.trialGrant(tx, wallet, workspaceId, policy.trial_credits, policy.trial_validity_days, configVersion));
  }

  /**
   * The trial grant itself, idempotent on "this workspace already has a trial row".
   * Shared by `grantTrial` and by workspace creation, which runs it inside its own
   * transaction through `withWalletTx`.
   */
  async trialGrant(
    tx: Tx,
    wallet: WalletTx,
    workspaceId: string,
    credits: number,
    validityDays: number,
    configVersion: number,
  ): Promise<LedgerWrite | null> {
    const already = await tx.creditLedger.findFirst({ where: { tenantId: workspaceId, reason: 'trial' }, select: { id: true } });
    if (already) return null;
    return wallet.grant({
      credits,
      reason: 'trial',
      expiresAt: addDays(new Date(), validityDays),
      refType: 'trial',
      policyVersion: configVersion,
    });
  }

  /**
   * credit-expiry job (§13.11): every lot past `expires_at` with credits left becomes one
   * negative `expiry` row and an empty lot. Returns the rows written.
   */
  async expireLots(workspaceId: string, now = new Date()): Promise<LedgerWrite[]> {
    return this.withWallet(workspaceId, (_tx, wallet) => wallet.sweepExpired(now));
  }

  private async notifyListeners(workspaceId: string, writes: LedgerWrite[]): Promise<void> {
    for (const write of writes) {
      if (write.duplicate) continue;
      for (const listener of this.listeners) {
        try {
          await listener({ workspaceId, write });
        } catch (error) {
          this.log.error(`ledger listener failed: ${String(error)}`);
        }
      }
    }
  }

  // ------------------------------------------------------------------ customer reads (D5)

  async summary(ctx: WorkspaceContext): Promise<WalletResponse> {
    const { tenant, nextLot, lastPaid, balance } = await withWorkspace(ctx, async (db) => {
      const [tenant, nextLot, lastPaid, sum] = await Promise.all([
        db.tenant.findUniqueOrThrow({
          where: { id: ctx.workspaceId },
          select: { planTier: true, concurrencyCap: true, kbAllowance: true, autoTopupJson: true },
        }),
        db.creditLot.findFirst({
          where: { tenantId: ctx.workspaceId, creditsRemaining: { gt: 0 }, expiresAt: { gt: new Date() } },
          orderBy: { expiresAt: 'asc' },
          select: { creditsRemaining: true, expiresAt: true },
        }),
        db.purchase.findFirst({
          where: { tenantId: ctx.workspaceId, status: 'paid' },
          orderBy: { createdAt: 'desc' },
          select: { credits: true },
        }),
        db.creditLedger.aggregate({ where: { tenantId: ctx.workspaceId }, _sum: { delta: true } }),
      ]);
      return { tenant, nextLot, lastPaid, balance: roundCredits(sum._sum.delta?.toNumber() ?? 0) };
    });
    // The read above is the truth *as of that read*, but it happened outside the wallet
    // lock, so a debit may have committed and published since. Fill a miss, never overwrite:
    // a plain SET here would put a stale-high balance back over a writer's fresher one.
    await this.cache.setIfAbsent(redisKeys.balance(ctx.workspaceId), balance.toFixed(2), BALANCE_TTL_S);

    return {
      balance,
      plan_tier: tenant.planTier,
      concurrency_cap: tenant.concurrencyCap,
      kb_allowance: tenant.kbAllowance,
      expiring_next: nextLot
        ? { credits: nextLot.creditsRemaining.toNumber(), expires_at: nextLot.expiresAt.toISOString() }
        : null,
      last_pack_credits: lastPaid?.credits ?? null,
      auto_topup: parseAutoTopup(tenant.autoTopupJson),
    };
  }

  async lots(ctx: WorkspaceContext): Promise<CreditLotResponse[]> {
    const rows = await withWorkspace(ctx, (db) =>
      db.creditLot.findMany({ where: { tenantId: ctx.workspaceId }, orderBy: { expiresAt: 'asc' } }),
    );
    return rows.map((lot) => ({
      id: lot.id,
      purchase_id: lot.purchaseId,
      credits_total: lot.creditsTotal.toNumber(),
      credits_remaining: lot.creditsRemaining.toNumber(),
      expires_at: lot.expiresAt.toISOString(),
      created_at: lot.createdAt.toISOString(),
    }));
  }

  async ledger(ctx: WorkspaceContext, query: LedgerQuery): Promise<Page<LedgerEntryResponse>> {
    const rows = await withWorkspace(ctx, (db) =>
      db.creditLedger.findMany({
        ...cursorArgs(query),
        where: { tenantId: ctx.workspaceId, ...(query.reason ? { reason: query.reason } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
    const page = toPage(rows, query);
    return {
      next_cursor: page.next_cursor,
      items: page.items.map((row) => ({
        id: row.id,
        delta: row.delta.toNumber(),
        balance_after: row.balanceAfter.toNumber(),
        reason: row.reason,
        ref_type: row.refType,
        ref_id: row.refId,
        created_at: row.createdAt.toISOString(),
      })),
    };
  }
}

/**
 * The ledger operations available inside one locked wallet transaction. Constructed only
 * by `WalletService.withWallet`; never hold one past the callback.
 */
export class WalletTx {
  constructor(
    private readonly service: WalletService,
    private readonly tx: Tx,
    readonly workspaceId: string,
    private readonly writes: LedgerWrite[],
  ) {}

  async grant(input: GrantInput): Promise<LedgerWrite> {
    const credits = roundCredits(input.credits);
    if (credits <= 0) throw new Error(`grant needs a positive amount, got ${input.credits}`);

    // Before the overdraft settles against this lot, so lapsed credits are gone from the
    // balance the settlement is measured against rather than paid back out of a new pack.
    await this.sweepExpired();
    const before = await this.balanceInTx();
    const after = roundCredits(before + credits);

    const lot = await this.tx.creditLot.create({
      data: {
        tenantId: this.workspaceId,
        purchaseId: input.purchaseId,
        creditsTotal: credits,
        creditsRemaining: lotRemainingAfterSettling(credits, before),
        expiresAt: input.expiresAt,
        policyVersion: input.policyVersion,
      },
    });
    const row = await this.tx.creditLedger.create({
      data: {
        tenantId: this.workspaceId,
        delta: credits,
        balanceAfter: after,
        reason: input.reason,
        refType: input.refType,
        refId: input.refId,
        lotId: lot.id,
      },
    });
    return this.record(row, false);
  }

  async debit(input: DebitInput): Promise<LedgerWrite> {
    const credits = roundCredits(input.credits);
    if (credits <= 0) throw new Error(`debit needs a positive amount, got ${input.credits}`);

    if (input.reason === 'call') {
      if (!input.refId) throw new Error('a call debit needs the call id as ref_id');
      const existing = await this.tx.creditLedger.findFirst({ where: { tenantId: this.workspaceId, reason: 'call', refId: input.refId } });
      if (existing) return this.record(existing, true);
    }
    // D7 §5.3: a rental period is debited once, keyed `<number id>:<period>`. Same shape as
    // the call guarantee — pre-check for the common replay, `credit_ledger_rental_debit_once_idx`
    // for the race.
    const rentalPeriod = input.reason === 'rental' && input.refType === RENTAL_REF_TYPE;
    if (rentalPeriod) {
      if (!input.refId) throw new Error('a rental debit needs <number id>:<period> as ref_id');
      const existing = await this.tx.creditLedger.findFirst({ where: { tenantId: this.workspaceId, reason: 'rental', refType: RENTAL_REF_TYPE, refId: input.refId } });
      if (existing) return this.record(existing, true);
    }
    // D13 SA9: a refund reverses a purchase's credits once per refund row. The staff path
    // retries a refund whose Stripe call succeeded but whose ledger write did not, so the
    // second write must find the first (same `ref_id`, under the same wallet lock).
    if (input.reason === 'refund') {
      if (!input.refId) throw new Error('a refund debit needs the refund id as ref_id');
      const existing = await this.tx.creditLedger.findFirst({ where: { tenantId: this.workspaceId, reason: 'refund', refType: REFUND_REF_TYPE, refId: input.refId } });
      if (existing) return this.record(existing, true);
    }

    // FIFO below only sees lots that are still live, so anything already lapsed has to be
    // written off first — otherwise this debit overdraws past it and the credit-expiry job
    // later writes the same credits off again, charging them twice.
    const now = new Date();
    await this.sweepExpired(now);

    const before = await this.balanceInTx();
    const after = roundCredits(before - credits);

    const openLots = await this.tx.creditLot.findMany({
      where: { tenantId: this.workspaceId, creditsRemaining: { gt: 0 }, expiresAt: { gt: now } },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, creditsRemaining: true },
    });
    const { draws } = allocateFifo(
      openLots.map((l) => ({ id: l.id, remaining: l.creditsRemaining.toNumber() })),
      credits,
    );
    for (const draw of draws) {
      await this.tx.creditLot.update({
        where: { id: draw.id },
        data: { creditsRemaining: { decrement: draw.take } },
      });
    }

    try {
      const row = await this.tx.creditLedger.create({
        data: {
          tenantId: this.workspaceId,
          delta: -credits,
          balanceAfter: after,
          reason: input.reason,
          refType: input.refType,
          refId: input.refId,
          lotId: draws[0]?.id,
        },
      });
      return this.record(row, false);
    } catch (error) {
      // Lost the race the pre-check exists to avoid: the index held. The transaction is
      // now aborted, so the lot decrements above roll back with it.
      if (input.reason === 'call' && isDuplicateCallDebit(error)) {
        throw new DuplicateCallDebit(input.refId ?? '');
      }
      if (rentalPeriod && isDuplicateRentalDebit(error)) {
        throw new DuplicateRentalDebit(input.refId ?? '');
      }
      throw error;
    }
  }

  /**
   * Writes off every lot already past `expires_at` (§13.11). Both the credit-expiry job
   * and every grant or debit run this first, so the lots FIFO can draw from are exactly
   * the lots the balance still counts. Idempotent: a swept lot is at 0 and drops out of
   * the filter, so the job that follows finds nothing left to do.
   */
  async sweepExpired(now = new Date()): Promise<LedgerWrite[]> {
    const lapsed = await this.tx.creditLot.findMany({
      where: { tenantId: this.workspaceId, expiresAt: { lte: now }, creditsRemaining: { gt: 0 } },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, creditsRemaining: true },
    });
    const out: LedgerWrite[] = [];
    for (const lot of lapsed) {
      out.push(await this.expireLot(lot.id, lot.creditsRemaining.toNumber()));
    }
    return out;
  }

  /** One lot's leftover becomes an `expiry` row. */
  async expireLot(lotId: string, remaining: number): Promise<LedgerWrite> {
    const credits = roundCredits(remaining);
    const before = await this.balanceInTx();
    await this.tx.creditLot.update({ where: { id: lotId }, data: { creditsRemaining: 0 } });
    const row = await this.tx.creditLedger.create({
      data: {
        tenantId: this.workspaceId,
        delta: -credits,
        balanceAfter: roundCredits(before - credits),
        reason: 'expiry',
        refType: 'lot',
        refId: lotId,
        lotId,
      },
    });
    return this.record(row, false);
  }

  /** Σ delta inside the locked transaction — the balance no concurrent write can move. */
  balanceInTx(): Promise<number> {
    return this.service['sumLedger'](this.tx, this.workspaceId);
  }

  private record(row: { id: string; delta: Prisma.Decimal; balanceAfter: Prisma.Decimal; reason: LedgerReason; refId: string | null; lotId: string | null }, duplicate: boolean): LedgerWrite {
    const write: LedgerWrite = {
      id: row.id,
      delta: row.delta.toNumber(),
      balance_after: row.balanceAfter.toNumber(),
      reason: row.reason,
      ref_id: row.refId,
      lot_id: row.lotId,
      duplicate,
    };
    this.writes.push(write);
    return write;
  }
}

/** Thrown only when two `call_ended` for one call race past the pre-check; the caller treats it as a no-op. */
export class DuplicateCallDebit extends Error {
  constructor(readonly callId: string) {
    super(`call ${callId} is already debited`);
  }
}

/** `ref_type` of a §5.3 monthly rental debit; `ref_id` is `<number id>:<period ISO>`. */
export const RENTAL_REF_TYPE = 'number_rental';

/** `ref_type` of a D13 refund reversal; `ref_id` is the `refunds.id`. */
export const REFUND_REF_TYPE = 'refund';

/** Two number-rental runs racing on one period; the loser treats it as already charged. */
export class DuplicateRentalDebit extends Error {
  constructor(readonly refId: string) {
    super(`rental ${refId} is already debited`);
  }
}

/**
 * Serialises wallet writes per workspace for the rest of the transaction. `hashtext` maps
 * the uuid to an int4; collisions between two workspaces only cost a moment of waiting,
 * never correctness.
 */
async function lockWallet(tx: Tx, workspaceId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'wallet:' + workspaceId}))`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Calendar months, clamped at month end (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

function parseAutoTopup(value: unknown): AutoTopup | null {
  if (!value) return null;
  const parsed = autoTopupSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
