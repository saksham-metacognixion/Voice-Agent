import type { AgentTier, RetellLanguage } from '@portal/schemas';
import type Retell from 'retell-sdk';
import { z } from 'zod';

/*
 * Types the rest of the backend uses to talk to the gateway. Nothing here is a Retell
 * wire type — those stay inside the gateway — except where a value is passed through
 * verbatim (model and voice ids, which are configuration, not code).
 */

export type LlmModel = NonNullable<Retell.LlmCreateParams['model']>;
export type VoiceModel = NonNullable<Retell.AgentCreateParams['voice_model']>;

/**
 * The TTS models Retell accepts, as a **runtime** check.
 *
 * Every other id in the tier stack fails loudly when it is wrong: an unknown LLM model is
 * a 400 (`request/body/model must be equal to one of the allowed values: …`), an unknown
 * voice is a 400. `voice_model` is the exception — Retell **silently ignores** a value it
 * does not know and substitutes its default. The seeded Premium stack asked for
 * `eleven_turbo_v2_5`, which is not in this list, so every Premium agent quietly ran the
 * Standard tier's `eleven_flash_v2_5` while billing 1.5× for the difference. Nothing
 * failed, which is precisely why it survived to be found by
 * `scripts/d5-retell-verify.ts`.
 *
 * So this list is not belt and braces; it is the only thing standing between a typo in
 * SA6 and a tier that silently does not exist.
 */
export const voiceModel = z.enum([
  'eleven_flash_v2', 'eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3',
  'sonic-3', 'sonic-3-latest', 'sonic-3.5', 'sonic-3.6',
  'tts-1', 'gpt-4o-mini-tts',
  'speech-02-turbo', 'speech-2.8-turbo',
  's1', 's2-pro', 's2.1-pro',
  'inworld-tts-2', 'inworld-tts-2-flash',
]);

/** Same seam as the locale list: an SDK upgrade that drops a value fails the build. */
type _VoiceModelIsSupported = z.infer<typeof voiceModel> extends VoiceModel ? true : never;
const _voiceModelIsSupported: _VoiceModelIsSupported = true;
void _voiceModelIsSupported;
export type Language = NonNullable<Retell.AgentCreateParams['language']>;

/**
 * Compile-time proof that the locale list in `@portal/schemas` is a subset of the one the
 * SDK accepts.
 *
 * `retellLanguage` has to live in the schema package (deps: zod only, and W3's picker runs
 * in the browser), which means it cannot import the SDK to derive itself. This assertion
 * is the seam: if an SDK upgrade renames or drops a locale, `pnpm typecheck` fails here
 * instead of a customer's publish failing at `update-agent`. Widening is free — a locale
 * Retell adds and we have not listed simply is not offered yet.
 */
type _RetellLanguageIsSupported = RetellLanguage extends Extract<Language, string> ? true : never;
const _retellLanguageIsSupported: _RetellLanguageIsSupported = true;
void _retellLanguageIsSupported;
export type PostCallAnalysisField = NonNullable<Retell.AgentCreateParams['post_call_analysis_data']>[number];
export type PostCallAnalysisModel = NonNullable<Retell.AgentCreateParams['post_call_analysis_model']>;

/**
 * One tier's stack, as stored in `agent_stack_configs.tiers_json` (admin SA6). The
 * gateway maps tier → stack from this and only this; the ids are never in code
 * (CLAUDE.md, "never hard-code a price, rate, cap or model id").
 */
export const tierStack = z.object({
  model: z.string().min(1),
  /** Default voice when the customer has not picked one (W3). */
  default_voice_id: z.string().min(1),
  /** Validated, not a free string: Retell ignores an unknown one without complaint. */
  voice_model: voiceModel.optional(),
  /**
   * Post-call analysis is a flat per-call charge on Retell (ADR 0003 §21), so the model
   * that runs it is part of the tier's cost, not a global constant.
   */
  post_call_analysis_model: z.string().min(1).optional(),
  /** Retell default is 3 600 000; the plan max per tier lives here. */
  max_call_duration_ms: z.number().int().min(60_000).max(7_200_000),
  denoising_mode: z.enum(['no-denoise', 'noise-cancellation', 'noise-and-background-speech-cancellation']).optional(),
  stt_mode: z.enum(['fast', 'accurate']).optional(),
});
export type TierStack = z.infer<typeof tierStack>;

export const agentStackTiers = z.object({ standard: tierStack, premium: tierStack });
export type AgentStackTiers = z.infer<typeof agentStackTiers>;

export function stackFor(tiers: AgentStackTiers, tier: AgentTier): TierStack {
  return agentStackTiers.parse(tiers)[tier];
}

/** What a published `agent_versions` row projects onto Retell's LLM object. */
export interface LlmSpec {
  prompt: string;
  beginMessage?: string | null;
  model: LlmModel;
  knowledgeBaseIds?: string[];
  /** Compiled from `brief_json` + §9.7; the inbound webhook overrides per call. */
  defaultDynamicVariables?: Record<string, string>;
  /** Transfer targets (§11) become Retell transfer_call tools. Phase 2 for the billing split. */
  transferNumbers?: string[];
}

/** Agent-level settings. `webhookUrl` is always ours; callers cannot change it. */
export interface AgentSpec {
  name: string;
  llmId: string;
  voiceId: string;
  voiceModel?: VoiceModel;
  /** W3's two voice dials. Undefined leaves Retell's own default in place. */
  voiceSpeed?: number;
  voiceTemperature?: number;
  /**
   * A customer-chosen locale, `multi` when they picked an "also speaks" (W3), or an
   * explicit list. The array form is what the D2 spike established against the live API
   * and what `scripts/retell-spike.ts` still sends, so it stays supported; the product
   * path sends a scalar. Narrowed to our own validated locale list rather than the SDK's,
   * so an unvalidated string still cannot reach the wire.
   */
  language: RetellLanguage | 'multi' | RetellLanguage[];
  maxCallDurationMs: number;
  postCallAnalysis?: PostCallAnalysisField[];
  /** From the tier stack; Retell bills post-call analysis per call (ADR 0003 §21). */
  postCallAnalysisModel?: PostCallAnalysisModel;
  denoisingMode?: TierStack['denoising_mode'];
  sttMode?: TierStack['stt_mode'];
  timezone?: string;
}

/** Wire shape of the §13.9 inbound answer, as established on D2 (ADR 0003 §1). */
export interface InboundAllow {
  call_inbound: {
    override_agent_id?: string;
    override_agent_version?: number;
    dynamic_variables?: Record<string, string>;
    metadata?: Record<string, unknown>;
    agent_override?: { agent?: { max_call_duration_ms?: number } };
  };
}
export interface InboundDecline {
  call_inbound: { reject: true };
}
export type InboundResponse = InboundAllow | InboundDecline;

export interface AllowOptions {
  agentId: string;
  /** Omit to let the number's own binding decide (it runs latest_published). */
  agentVersion?: number;
  dynamicVariables?: Record<string, string>;
  metadata?: Record<string, unknown>;
  /** min(planMax, remainingCredits/rate × 60 000), computed by the caller. */
  maxCallDurationMs?: number;
}
