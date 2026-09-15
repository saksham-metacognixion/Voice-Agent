import type { AgentTier } from '@portal/schemas';
import type Retell from 'retell-sdk';
import { z } from 'zod';

/*
 * Types the rest of the backend uses to talk to the gateway. Nothing here is a Retell
 * wire type — those stay inside the gateway — except where a value is passed through
 * verbatim (model and voice ids, which are configuration, not code).
 */

export type LlmModel = NonNullable<Retell.LlmCreateParams['model']>;
export type VoiceModel = NonNullable<Retell.AgentCreateParams['voice_model']>;
export type Language = NonNullable<Retell.AgentCreateParams['language']>;
export type PostCallAnalysisField = NonNullable<Retell.AgentCreateParams['post_call_analysis_data']>[number];

/**
 * One tier's stack, as stored in `agent_stack_configs.tiers_json` (admin SA6). The
 * gateway maps tier → stack from this and only this; the ids are never in code
 * (CLAUDE.md, "never hard-code a price, rate, cap or model id").
 */
export const tierStack = z.object({
  model: z.string().min(1),
  /** Default voice when the customer has not picked one (W3). */
  default_voice_id: z.string().min(1),
  voice_model: z.string().min(1).optional(),
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
  language: Language;
  maxCallDurationMs: number;
  postCallAnalysis?: PostCallAnalysisField[];
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
