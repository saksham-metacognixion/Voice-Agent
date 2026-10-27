import type { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../common/errors/app-error';
import { type RedisCache, type RedisLike, redisKeys } from '../redis';
import { clampDuration } from '../retell';
import { roundCredits } from '../wallet/fifo';
import { ACTIVE_SLACK_MS, RETELL_MAX_CALL_MS, encodeActive, parseActiveHash } from './inbound.decide';
import { type ReserveResult, reserveActive } from './reserve.script';

/**
 * The ADR 0011 §1 sizing and slot for a call we mint ourselves — the browser test, "Call
 * my phone", the forwarding test and the website widget — kept in one place so the
 * services cannot drift apart. The §13.9 inbound path has its own sizing inside the pure
 * `decide()`, which reads the same `active:{ws}` hash from its MGET instead, and writes
 * through the same `reserveActive()`.
 */

/**
 * §13.4: ten test calls per workspace per hour, shared by every test that rings — the
 * browser test, "Call my phone" and the forwarding test.
 */
export const TEST_CALLS_PER_HOUR = 10;
const TEST_WINDOW_S = 3_600;

/**
 * §13.4's fixed hourly window: the counter starts with the first call of the hour and
 * expires an hour later whatever comes after it (`RedisCache.increment`, `SET NX` + `INCR`
 * — a `SET … EX` on every call would push the window out for as long as the calls keep
 * coming). It is read here and bumped by `countTestCall` after the platform has answered,
 * so a burst can slip one over and a refused mint costs nothing; Redis down means allow.
 * A test call spends real minutes — but the customer's own, which the balance check
 * gates, so the limit is abuse control and not the wallet.
 */
export async function assertUnderTestWindow(cache: RedisCache, workspaceId: string): Promise<void> {
  const used = Number(await cache.get(redisKeys.testCallWindow(workspaceId)));
  if (Number.isFinite(used) && used >= TEST_CALLS_PER_HOUR) {
    throw new AppError('TEST_RATE_LIMIT', `That is ${TEST_CALLS_PER_HOUR} test calls this hour. Try again a little later.`);
  }
}

export async function countTestCall(cache: RedisCache, workspaceId: string): Promise<void> {
  await cache.increment(redisKeys.testCallWindow(workspaceId), TEST_WINDOW_S);
}

export interface LiveCalls {
  count: number;
  credits: number;
}

/**
 * The live entries of `active:{ws}`: how many, and the credits they hold between them.
 * Redis unreachable reads as "none" — the inbound path fails open on the same policy
 * (ADR 0003 §12), and `call_started` reserves anyway.
 */
export async function liveCalls(redis: RedisLike, workspaceId: string, log: Logger): Promise<LiveCalls> {
  try {
    const { live } = parseActiveHash(await redis.hgetall(redisKeys.activeCalls(workspaceId)), Date.now());
    return { count: live.length, credits: live.reduce((sum, a) => sum + a.credits, 0) };
  } catch (error) {
    log.warn(`active:{${workspaceId}}: could not read the live calls before minting: ${String(error)}`);
    return { count: 0, credits: 0 };
  }
}

export type Headroom =
  | { ok: true; remaining: number; maxMs: number; cap: number | null }
  | { ok: false; reason: 'cap'; cap: number }
  | { ok: false; reason: 'credits' };

/**
 * Whether a new call fits beside the live ones, and its ceiling if it does: a free line of
 * the plan (`cap` null or 0 = no limit), credits left after the other calls' reservations,
 * and min(the agent's own ceiling, what those credits cover) inside the platform's
 * [60 s, 2 h].
 */
export function headroom(input: { balance: number; live: LiveCalls; cap: number | null | undefined; rate: number; maxDurationS: number }): Headroom {
  const cap = input.cap && input.cap > 0 ? input.cap : null;
  if (cap !== null && input.live.count >= cap) return { ok: false, reason: 'cap', cap };
  const remaining = roundCredits(input.balance - input.live.credits);
  if (!(remaining > 0)) return { ok: false, reason: 'credits' };
  const coveredMs = input.rate > 0 ? (remaining / input.rate) * 60_000 : Number.POSITIVE_INFINITY;
  return { ok: true, remaining, maxMs: clampDuration(Math.min(input.maxDurationS * 1_000, coveredMs)), cap };
}

export interface WebCallTransport {
  transport?: string;
  url?: string;
  ice_servers?: Record<string, unknown>[];
  expires_at?: number;
}

/** The SDK's connection fields from a minted web call, passed through to the browser only when present. */
export function webCallTransport(call: unknown): WebCallTransport {
  const extra = call as WebCallTransport;
  return {
    ...(extra.transport ? { transport: extra.transport } : {}),
    ...(extra.url ? { url: extra.url } : {}),
    ...(extra.ice_servers ? { ice_servers: extra.ice_servers } : {}),
    ...(typeof extra.expires_at === 'number' ? { expires_at: extra.expires_at } : {}),
  };
}

/** How long a slot taken before the mint holds without a call id: past any mint, short of a stranded field. */
const MINT_HOLD_MS = 120_000;
/** The longest any field can live, so a mint never shortens the key under a longer call. */
const ACTIVE_KEY_TTL_S = Math.ceil((RETELL_MAX_CALL_MS + ACTIVE_SLACK_MS) / 1_000) + 60;

/**
 * A call's line in `active:{ws}`, taken **before** the platform is asked to mint it.
 * `headroom()` only reads the hash, and two presses in the same second — two tabs, two
 * editors, twenty strangers on a widget — would each see the same free line and the same
 * credits. So the slot is written by the inbound path's atomic check-and-reserve (ADR
 * 0011 §1) under a placeholder field, then moved to the call id once the platform answers
 * (`bind`) or freed if it refuses (`release`). Before, not after: "Call my phone" and the
 * forwarding test dial the moment they are minted, and a slot lost after that would come
 * too late to stop the call.
 *
 * `skipped` when Redis could not take the write: the call goes ahead, as on the inbound
 * path, and `call_started` reserves it. `bind` uses HSETNX because `call_started` may
 * have reserved the call already; it never overwrites a field.
 */
export class MintSlot {
  private constructor(
    private readonly redis: RedisLike,
    private readonly log: Logger,
    private readonly workspaceId: string,
    private readonly placeholder: string,
    private readonly credits: number,
    private readonly maxMs: number,
    readonly result: ReserveResult,
  ) {}

  static async take(
    redis: RedisLike,
    log: Logger,
    input: { workspaceId: string; maxMs: number; rate: number; cap: number | null; balance: number },
  ): Promise<MintSlot> {
    const placeholder = `mint:${randomUUID()}`;
    const credits = roundCredits((input.maxMs / 60_000) * (input.rate > 0 ? input.rate : 0));
    const now = Date.now();
    let result: ReserveResult;
    try {
      result = await reserveActive(redis, input.workspaceId, {
        callId: placeholder,
        credits,
        expiresAt: now + MINT_HOLD_MS,
        now,
        cap: input.cap,
        ceiling: input.balance,
        ttlSeconds: ACTIVE_KEY_TTL_S,
      });
    } catch (error) {
      log.warn(`active:{${input.workspaceId}}: slot not taken before minting (${error instanceof Error ? error.message : String(error)})`);
      result = 'skipped';
    }
    return new MintSlot(redis, log, input.workspaceId, placeholder, credits, input.maxMs, result);
  }

  /** The platform minted `callId`: the slot is the call's for as long as it may run. */
  async bind(callId: string): Promise<void> {
    if (this.result !== 'ok') return;
    const key = redisKeys.activeCalls(this.workspaceId);
    try {
      await this.redis.hsetnx(key, callId, encodeActive(this.credits, Date.now() + this.maxMs + ACTIVE_SLACK_MS));
      await this.redis.hdel(key, this.placeholder);
    } catch (error) {
      // The placeholder holds the line until MINT_HOLD_MS, and `call_started` reserves the call.
      this.log.warn(`active:{${this.workspaceId}}: slot not moved to ${callId} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** The platform refused: nothing will ring, so the line is free again. */
  async release(): Promise<void> {
    if (this.result !== 'ok') return;
    await this.redis.hdel(redisKeys.activeCalls(this.workspaceId), this.placeholder).catch(() => undefined);
  }
}
