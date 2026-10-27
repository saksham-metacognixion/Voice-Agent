import type { Logger } from '@nestjs/common';
import { type RedisLike, redisKeys } from '../redis';
import { clampDuration } from '../retell';
import { roundCredits } from '../wallet/fifo';
import { parseActiveHash } from './inbound.decide';

/**
 * The ADR 0011 §1 sizing for a call we mint ourselves — the browser test, "Call my phone"
 * and the website widget — kept in one place so the two services cannot drift apart. The
 * §13.9 inbound path has its own copy inside the pure `decide()`, which reads the same
 * `active:{ws}` hash from its MGET instead.
 */

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
