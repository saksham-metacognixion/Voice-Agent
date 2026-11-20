import { Injectable, Logger } from '@nestjs/common';
import { adminDb } from '@portal/db';
import { type AgentTier, type AnalysisField, analysisField } from '@portal/schemas';
import { RedisCache, redisKeys } from '../redis';
import { DEFAULT_PLATFORM_GUARDRAILS, guardrailLines } from '../prompting/guardrails';
import { DEFAULT_LINT_CONFIG, type LintConfig, lintConfigFrom } from '../prompting/lint';
import { APPENDIX_B_SKELETON, DEFAULT_SYSTEM_PROMPT } from '../prompting/prompt-builder';
import { type AgentStackTiers, agentStackTiers, stackFor, type TierStack } from '../retell';

/**
 * `agent_stack_configs` (admin SA6) read as configuration, the same way pricing is
 * (CLAUDE.md, "Configuration"): model and voice ids per tier, the §9.4 guardrail text,
 * the §9.5 lint severities and the §9.3 generation prompts, all versioned rows rather
 * than constants in a service.
 *
 * Every field degrades to a compiled-in default, and the degradation is not a nicety: a
 * stack row that is missing, truncated or malformed must never mean "append no
 * guardrails" or "skip the lint". An empty table is a perfectly good dev database.
 *
 * Cached in Redis under `stack:current` with the same 60 s TTL the rest of the
 * configuration uses, so an SA6 publish is live within a minute even if the invalidation
 * is missed. `adminDb`, because the table is global and this runs on request, webhook and
 * worker paths alike (ADR 0006).
 */

export interface AgentStack {
  /** 0 when the table is empty and every value below is a compiled-in default. */
  version: number;
  tiers: AgentStackTiers | null;
  /** The §9.4 bullets in force. Never empty. */
  guardrails: string[];
  lint: LintConfig;
  prompts: {
    system: string;
    skeleton: string;
    alwaysAnalysisFields: AnalysisField[];
  };
}

/** Same TTL as the rest of the configuration (admin §5.2 step 4). */
export const STACK_TTL_S = 60;
export const STACK_CACHE_KEY = redisKeys.agentStackCurrent;

@Injectable()
export class AgentStackService {
  private readonly log = new Logger(AgentStackService.name);

  constructor(private readonly cache: RedisCache) {}

  async current(): Promise<AgentStack> {
    const { value } = await this.cache.remember<AgentStack>(STACK_CACHE_KEY, STACK_TTL_S, () => this.load());
    // A cache round trip loses nothing but the class of `lint.severities`; rebuild the
    // defaults underneath so a partial document can never disable a rule.
    return { ...value, lint: { ...DEFAULT_LINT_CONFIG, ...value.lint, guardrails: value.guardrails } };
  }

  /** The tier stack for one agent — model, voice, denoising, the plan's duration ceiling. */
  async tierStack(tier: AgentTier): Promise<TierStack | null> {
    const stack = await this.current();
    if (!stack.tiers) return null;
    try {
      return stackFor(stack.tiers, tier);
    } catch (error) {
      this.log.error(`agent_stack_configs tiers are invalid for ${tier}: ${String(error)}`);
      return null;
    }
  }

  async invalidate(): Promise<void> {
    await this.cache.del(STACK_CACHE_KEY);
  }

  private async load(): Promise<AgentStack> {
    const row = await adminDb.agentStackConfig.findFirst({ orderBy: { version: 'desc' } });
    if (!row) {
      this.log.warn('agent_stack_configs is empty; using the compiled-in stack. Run `pnpm db:seed`.');
      return this.defaults();
    }

    const tiers = agentStackTiers.safeParse(row.tiersJson);
    if (!tiers.success) {
      this.log.error(`agent_stack_configs v${row.version} tiers_json is invalid: ${tiers.error.issues[0]?.message ?? 'unknown'}`);
    }

    const guardrails = guardrailLines(row.guardrailsText);
    const prompts = (row.generationPromptsJson ?? {}) as Record<string, unknown>;

    return {
      version: row.version,
      tiers: tiers.success ? tiers.data : null,
      guardrails,
      lint: lintConfigFrom(row.lintJson, guardrails),
      prompts: {
        system: stringOr(prompts.system, DEFAULT_SYSTEM_PROMPT),
        skeleton: stringOr(prompts.skeleton, APPENDIX_B_SKELETON),
        alwaysAnalysisFields: parseFields(prompts.always_analysis_fields),
      },
    };
  }

  private defaults(): AgentStack {
    const guardrails = [...DEFAULT_PLATFORM_GUARDRAILS];
    return {
      version: 0,
      tiers: null,
      guardrails,
      lint: { ...DEFAULT_LINT_CONFIG, guardrails },
      prompts: {
        system: DEFAULT_SYSTEM_PROMPT,
        skeleton: APPENDIX_B_SKELETON,
        alwaysAnalysisFields: ALWAYS_ANALYSIS_FIELDS,
      },
    };
  }
}

/** §9.8: "template fields + caller_intent, follow_up_required". */
export const ALWAYS_ANALYSIS_FIELDS: AnalysisField[] = [
  { name: 'caller_intent', type: 'text', description: 'What the caller wanted, in one short phrase.' },
  { name: 'follow_up_required', type: 'boolean', description: 'True when a person still needs to act on this call.' },
];

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function parseFields(value: unknown): AnalysisField[] {
  if (!Array.isArray(value)) return ALWAYS_ANALYSIS_FIELDS;
  const parsed = value.map((entry) => analysisField.safeParse(entry)).filter((r) => r.success);
  return parsed.length ? parsed.map((r) => r.data!) : ALWAYS_ANALYSIS_FIELDS;
}
