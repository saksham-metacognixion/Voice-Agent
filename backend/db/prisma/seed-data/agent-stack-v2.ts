import { AGENT_STACK_V1_TIERS, GENERATION_PROMPTS_V1, LINT_CONFIG_V1, PLATFORM_GUARDRAILS_V1 } from './agent-stack-v1.js';

/**
 * `agent_stack_configs` version 2 — the tier stack aligned with spec §4.3 and the P0
 * benchmark (ADR 0037, ADR 0038). Versions are immutable; `pnpm db:seed` adds this one to an
 * environment that does not have it and never edits a row that exists.
 *
 * What changed from v1, and why:
 *
 *   - Standard LLM `gpt-5-mini` → `gpt-4.1-mini`. §20 item 3, decided by `bench:incall` on
 *     4 Nov (ADR 0037 §1) and rerun on the v2 prompt before this row shipped (ADR 0038).
 *   - Premium: the LLM **stays** `gpt-4.1-mini`, against §4.3's GPT-4.1 (ADR 0038, 4 Nov).
 *     Held to the bar ADR 0037 set Standard, GPT-4.1 failed it on `bench:incall`: it hung
 *     up before the caller was done in 14 of 30 conversations (GPT-4.1 mini 9 of 30), with
 *     the same 90.3 % of checks, at 3.5× the model cost. The tiers still differ in voice
 *     (ElevenLabs), transcription (`accurate`), denoising and the call ceiling.
 *   - Standard default voice `11labs-Adrian` (ElevenLabs Flash, $0.040/min, a voice our own
 *     catalogue files under Premium) → `cartesia-Adrian` ($0.015/min, §4.3's "Retell platform
 *     / Cartesia"). Same name, same American male persona; its sample clip already ships.
 *     No `voice_model`: a Cartesia voice runs its provider's default, as every Standard
 *     agent that picked a Cartesia voice on W3 already does.
 *   - `transfer_tool_missing` is a warning (ADR 0038): the rule now fires on a phone number's
 *     own transfer target, which a publish of the agent cannot fix.
 *
 * Unchanged: the post-call analysis model, the guardrail text, the generation prompts, the
 * ceilings and the transcription modes.
 */
export const AGENT_STACK_V2_TIERS = {
  standard: {
    model: 'gpt-4.1-mini',
    default_voice_id: 'cartesia-Adrian',
    post_call_analysis_model: AGENT_STACK_V1_TIERS.standard.post_call_analysis_model,
    max_call_duration_ms: AGENT_STACK_V1_TIERS.standard.max_call_duration_ms,
    stt_mode: AGENT_STACK_V1_TIERS.standard.stt_mode,
  },
  // Unchanged from v1 (`gpt-4.1-mini`): see "Premium" above.
  premium: AGENT_STACK_V1_TIERS.premium,
} as const;

export const LINT_CONFIG_V2 = {
  ...LINT_CONFIG_V1,
  severities: { ...LINT_CONFIG_V1.severities, transfer_tool_missing: 'warning' },
} as const;

export const PLATFORM_GUARDRAILS_V2 = PLATFORM_GUARDRAILS_V1;
export const GENERATION_PROMPTS_V2 = GENERATION_PROMPTS_V1;
