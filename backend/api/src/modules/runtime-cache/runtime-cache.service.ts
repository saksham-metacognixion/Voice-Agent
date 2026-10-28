import { Injectable, Logger } from '@nestjs/common';
import { adminDb } from '@portal/db';
import { type AgentTier, businessHours, type BusinessHours, rateForTier } from '@portal/schemas';
import { PlatformConfigService } from '../config';
import { RedisCache, redisKeys } from '../redis';
import { briefTransferNumbers, numberTransferTargets, spokenTransferFailMessage } from '../prompting/staff-transfer';
import { agentStackTiers, type AgentStackTiers } from '../retell';
import { WalletService } from '../wallet';
import { NUMBER_RECORD_VERSION, type NumberRecord, normalisePhone } from './number-record';

/**
 * A `num:{e164}` record outlives the periodic refresh many times over; the TTL only
 * bounds how long a number that vanished without a refresh keeps answering.
 */
export const NUMBER_TTL_S = 86_400;

export interface RefreshSummary {
  workspaceId: string;
  numbers: number;
  removed: number;
  balance: number;
}

/**
 * `runtime-cache.refresh(workspaceId)` (architecture §8–9): rebuilds everything the
 * inbound hot path reads for one workspace from Postgres — `num:{e164}` for each of its
 * numbers, `caps:{ws}`, and a warm `bal:{ws}` — so the six checks never open Postgres.
 *
 * Called from every mutating path: pause/resume, plan change, number change, publish
 * (D5–D8 call it as they land), the hot path itself on a miss (via the `calls` queue), a
 * worker boot, and the 5-minute `runtime-cache-refresh` schedule as the backstop for any
 * path that forgets (CLAUDE.md, "Inbound call authorisation").
 *
 * Always on `adminDb`: it runs from jobs and webhooks with no request context.
 */
@Injectable()
export class RuntimeCacheService {
  private readonly log = new Logger(RuntimeCacheService.name);

  constructor(
    private readonly cache: RedisCache,
    private readonly config: PlatformConfigService,
    private readonly wallet: WalletService,
  ) {}

  async refresh(workspaceId: string): Promise<RefreshSummary | null> {
    const tenant = await adminDb.tenant.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true, timezone: true, pausedAt: true, businessHoursJson: true },
    });
    if (!tenant) {
      this.log.warn(`refresh(${workspaceId}): workspace does not exist`);
      return null;
    }

    const [numbers, globalBlocklist, stack, pricing] = await Promise.all([
      adminDb.phoneNumber.findMany({
        where: { tenantId: workspaceId },
        include: { agent: { select: { id: true, name: true, tier: true, status: true, retellAgentId: true, maxCallDurationS: true, publishedVersion: true } } },
      }),
      this.globalPhoneBlocklist(),
      this.stackTiers(),
      // The rate is baked into the record so the hot path needs nothing but `num:{e164}`
      // for both halves of the duration formula; see NumberRecord.rate_per_min. A failure
      // here leaves the rate null, which is the same degraded-but-open state as before.
      this.config.currentPricing().catch((error: unknown) => {
        this.log.warn(`refresh(${workspaceId}): pricing unavailable, records get no rate: ${String(error)}`);
        return null;
      }),
    ]);

    const tenantHours = parseHours(tenant.businessHoursJson);
    const briefs = await this.publishedBriefs(numbers.map((n) => n.agent));
    let removed = 0;
    let written = 0;
    for (const number of numbers) {
      // D6: a bought number has no e164 until the platform answers; there is nothing to
      // key on yet and the inbound path cannot be asked about it.
      if (!number.e164) continue;
      if (number.status === 'released' || number.status === 'releasing' || number.status === 'failed') {
        removed += await this.cache.del(redisKeys.number(number.e164));
        continue;
      }
      const tier: AgentTier = number.agent?.tier ?? 'standard';
      const record: NumberRecord = {
        v: NUMBER_RECORD_VERSION,
        number_id: number.id,
        e164: number.e164,
        inbound_token: number.inboundToken,
        workspace_id: workspaceId,
        workspace_paused: tenant.pausedAt !== null,
        number_paused: number.pausedAt !== null || number.status === 'paused',
        number_active: number.status === 'active',
        agent_id: number.agent?.id ?? null,
        retell_agent_id: number.agent?.retellAgentId ?? null,
        agent_live: number.agent?.status === 'live',
        agent_name: number.agent?.name ?? null,
        tier,
        business_name: tenant.name,
        timezone: tenant.timezone,
        plan_max_ms: planMaxMs(number.agent?.maxCallDurationS ?? null, stack, tier),
        rate_per_min: pricing ? rateForTier(pricing.config.rates, tier) : null,
        config_version: pricing?.version ?? null,
        hours_mode: number.hoursMode,
        hours: number.hoursMode === 'custom' ? parseHours(number.hoursOverrideJson) : number.hoursMode === 'business' ? tenantHours : null,
        blocklist: [...new Set([...number.blocklist, ...globalBlocklist].map(normalisePhone).filter(Boolean))],
        transfer_numbers: numberTransferTargets(number.transferTargetsJson),
        // The brief's numbers too: they are the `transfer_number_N` defaults wherever the
        // number sets none, so the call can dial them and the message must not say them.
        transfer_fail_message: spokenTransferFailMessage(number.transferFailMessage, [
          ...numberTransferTargets(number.transferTargetsJson),
          ...briefTransferNumbers(number.agent ? briefs.get(number.agent.id) : undefined),
        ]),
        refreshed_at: new Date().toISOString(),
      };
      if (await this.cache.setJson(redisKeys.number(number.e164), record, NUMBER_TTL_S)) written += 1;
    }

    await this.config.refreshCaps(workspaceId);
    const balance = await this.wallet.balance(workspaceId);
    return { workspaceId, numbers: written, removed, balance };
  }

  /** After a `num:{e164}` miss on the hot path: find the number's workspace and refresh it. */
  async refreshNumber(e164: string): Promise<RefreshSummary | null> {
    const number = await adminDb.phoneNumber.findFirst({ where: { e164 }, select: { tenantId: true } });
    if (!number) {
      this.log.warn(`refreshNumber(${e164}): no such number; the inbound webhook for it was not ours`);
      return null;
    }
    return this.refresh(number.tenantId);
  }

  /** The periodic backstop and the worker-boot warm-up: every workspace that owns a number, plus the global keys. */
  async refreshAll(): Promise<{ workspaces: number; numbers: number }> {
    // Both global keys the hot path reads. `refreshRejectInbound()` rather than a plain
    // read: `kill:reject_inbound` is a projection with its own long TTL, and this schedule
    // is what keeps it alive between flips (redisKeys.rejectInbound).
    await Promise.all([this.config.currentPricing(), this.config.refreshRejectInbound()]);
    const owners = await adminDb.phoneNumber.findMany({
      where: { status: { notIn: ['released'] } },
      distinct: ['tenantId'],
      select: { tenantId: true },
    });
    let numbers = 0;
    for (const { tenantId } of owners) {
      try {
        numbers += (await this.refresh(tenantId))?.numbers ?? 0;
      } catch (error) {
        this.log.error(`refresh(${tenantId}) failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { workspaces: owners.length, numbers };
  }

  /** The published brief of each agent, which the number runs (`latest_published`). */
  private async publishedBriefs(agents: ReadonlyArray<{ id: string; publishedVersion: number | null } | null>): Promise<Map<string, unknown>> {
    const pairs = [...new Map(agents.flatMap((a) => (a && a.publishedVersion !== null ? [[a.id, a.publishedVersion] as const] : []))).entries()];
    if (!pairs.length) return new Map();
    const rows = await adminDb.agentVersion.findMany({
      where: { OR: pairs.map(([agentId, versionNo]) => ({ agentId, versionNo })) },
      select: { agentId: true, briefJson: true },
    });
    return new Map(rows.map((r) => [r.agentId, r.briefJson]));
  }

  private async globalPhoneBlocklist(): Promise<string[]> {
    const rows = await adminDb.blocklist.findMany({
      where: { type: 'phone', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { value: true },
    });
    return rows.map((r) => r.value);
  }

  /** The latest published agent stack, or null before SA6 has published one. */
  private async stackTiers(): Promise<AgentStackTiers | null> {
    const row = await adminDb.agentStackConfig.findFirst({ orderBy: { version: 'desc' }, select: { tiersJson: true } });
    if (!row) return null;
    const parsed = agentStackTiers.safeParse(row.tiersJson);
    return parsed.success ? parsed.data : null;
  }
}

function parseHours(value: unknown): BusinessHours | null {
  if (!value) return null;
  const parsed = businessHours.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** min(agent setting, stack tier max), in ms; null when neither exists (never a constant). */
export function planMaxMs(agentMaxS: number | null, stack: AgentStackTiers | null, tier: AgentTier): number | null {
  const candidates: number[] = [];
  if (agentMaxS && agentMaxS > 0) candidates.push(agentMaxS * 1000);
  const stackMax = stack?.[tier]?.max_call_duration_ms;
  if (stackMax && stackMax > 0) candidates.push(stackMax);
  return candidates.length ? Math.min(...candidates) : null;
}
