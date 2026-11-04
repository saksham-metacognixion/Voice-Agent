import type { AgentTier, BusinessHours } from '@portal/schemas';

/** Bump when the shape changes; the hot path treats an older record as a miss. */
export const NUMBER_RECORD_VERSION = 2 as const;

/**
 * `num:{e164}` — everything the six §13.9 checks and the allow answer need about one
 * number, denormalised so the hot path never opens Postgres (architecture §9). Written
 * only by `RuntimeCacheService`; read only by the inbound path.
 */
export interface NumberRecord {
  v: typeof NUMBER_RECORD_VERSION;
  number_id: string;
  e164: string;
  /** The path segment Retell was given; the request's token must match it. */
  inbound_token: string;
  workspace_id: string;
  workspace_paused: boolean;
  number_paused: boolean;
  /** `phone_numbers.status = active`. Provisioning or releasing numbers decline. */
  number_active: boolean;
  agent_id: string | null;
  retell_agent_id: string | null;
  /** `agents.status = live`. A paused or draft agent declines as `paused`. */
  agent_live: boolean;
  /**
   * The name the agent introduces itself by (§9.7 `{{agent_name}}`): the published brief's
   * `agent_name`, else `agents.name` — `spokenAgentName()`, the same reading a test call
   * gets. Null with no agent.
   */
  agent_name: string | null;
  /**
   * ADR 0038: the live agent's main language (`agents.primary_language`), for §9.7
   * `{{primary_language}}`. Optional like `transfer_fail_message`: a record written before
   * it existed reads as '' until the next refresh.
   */
  primary_language?: string | null;
  tier: AgentTier;
  business_name: string;
  timezone: string;
  /**
   * min(agent.max_call_duration_s, stack tier max) in ms, or null when neither is known.
   * The "planMax" of `min(planMax, remainingCredits/rate × 60000)`.
   */
  plan_max_ms: number | null;
  /**
   * Credits per minute for `tier`, from the pricing config current when this record was
   * written — the "rate" of that same formula.
   *
   * It lives here rather than being read from `pricing:current` on the hot path because
   * that key carries the 60 s config TTL (admin §5.2's "portal re-reads within 60 s")
   * while `runtime-cache-refresh` only runs every five minutes. The rate was therefore
   * absent for most of every cycle, and a decision without it reserves nothing and sizes
   * the call from `plan_max_ms` alone, which lets concurrent calls overrun the grace
   * (ADR 0011 §1). Both halves of the formula now expire together, with this record.
   *
   * Only ever a ceiling. What a call is *billed* is `calls.rate`, captured by the worker
   * from the live config, so a stale value here can never misprice anything.
   */
  rate_per_min: number | null;
  /** `pricing_configs.version` the rate came from; stamped onto the row this call creates. */
  config_version: number | null;
  hours_mode: 'always' | 'business' | 'custom';
  /** The schedule for `business` (tenant) or `custom` (number); null = treat as open. */
  hours: BusinessHours | null;
  /** E.164 callers to decline as `blocked`: the number's own list plus the global phone blocklist. */
  blocklist: string[];
  transfer_numbers: string[];
  /**
   * QA-083: the number's "message if the transfer fails", or null for the fixed rule's own
   * words. Optional so a record written before it existed still reads (no version bump —
   * that would turn every live record into a miss until the next refresh); absent = null.
   */
  transfer_fail_message?: string | null;
  /**
   * ADR 0035 (3 Nov 2026): the number's allowed caller countries (ISO 3166-1 alpha-2,
   * upper case), `phone_numbers.allowed_countries`. Empty = no restriction. Optional for
   * the same reason as `transfer_fail_message`; absent reads as empty, i.e. the
   * behaviour before the field existed, until the next refresh writes it.
   */
  allowed_countries?: string[];
  /**
   * ADR 0035: the *workspace's* hours (`tenants.business_hours_json`), whatever
   * `hours_mode` says — `hours` above is the answering schedule, this is what
   * `{{business_open}}` and `{{next_open_time}}` are computed from. Null = none set.
   */
  business_hours?: BusinessHours | null;
  refreshed_at: string;
}

export function isNumberRecord(value: unknown): value is NumberRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === NUMBER_RECORD_VERSION &&
    typeof r.number_id === 'string' &&
    typeof r.e164 === 'string' &&
    typeof r.inbound_token === 'string' &&
    typeof r.workspace_id === 'string' &&
    typeof r.tier === 'string' &&
    Array.isArray(r.blocklist)
  );
}

/** E.164-ish normalisation for blocklist comparison: digits only, leading + kept. */
export function normalisePhone(value: string): string {
  const digits = value.replace(/[^\d+]/g, '');
  if (!digits) return '';
  return digits.startsWith('+') ? `+${digits.slice(1).replace(/\+/g, '')}` : `+${digits}`;
}
