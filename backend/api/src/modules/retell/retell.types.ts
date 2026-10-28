import type { AgentLanguage, AgentTier, RetellLanguage } from '@portal/schemas';
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

/**
 * Which voice provider each TTS model belongs to. A model sent with a voice from another
 * provider is a 400 on `create-agent`/`update-agent` ("Selected voice model
 * eleven_flash_v2_5 is not supported for this voice provider", found by the D9 wizard run:
 * W3 offers every provider, the tier stack names one ElevenLabs model). So the stack's
 * model is sent only with a voice of its own provider; with any other voice it is sent
 * as `null`, which clears the model an earlier sync stored (omitting it is not enough:
 * `update-agent` keeps the stored ElevenLabs model and rejects the Cartesia voice
 * against it) and lets the platform use that provider's default.
 */
const VOICE_MODEL_PROVIDER: Record<z.infer<typeof voiceModel>, string> = {
  eleven_flash_v2: 'elevenlabs', eleven_flash_v2_5: 'elevenlabs', eleven_multilingual_v2: 'elevenlabs', eleven_v3: 'elevenlabs',
  'sonic-3': 'cartesia', 'sonic-3-latest': 'cartesia', 'sonic-3.5': 'cartesia', 'sonic-3.6': 'cartesia',
  'tts-1': 'openai', 'gpt-4o-mini-tts': 'openai',
  'speech-02-turbo': 'minimax', 'speech-2.8-turbo': 'minimax',
  s1: 'fish_audio', 's2-pro': 'fish_audio', 's2.1-pro': 'fish_audio',
  'inworld-tts-2': 'inworld', 'inworld-tts-2-flash': 'inworld',
};

/** The id prefixes `list-voices` uses per provider — the fallback when a voice is not in our cache. */
const VOICE_ID_PREFIX: Array<[string, string]> = [
  ['11labs-', 'elevenlabs'], ['cartesia-', 'cartesia'], ['openai-', 'openai'], ['minimax-', 'minimax'], ['fish_audio-', 'fish_audio'], ['inworld-', 'inworld'],
];

export function providerOfVoiceId(voiceId: string): string | null {
  return VOICE_ID_PREFIX.find(([prefix]) => voiceId.startsWith(prefix))?.[1] ?? null;
}

/** The stack's TTS model when it fits the voice's provider, otherwise `null` (clear it: the provider's default). */
export function voiceModelFor(voiceProvider: string | null, model: VoiceModel | undefined): VoiceModel | null {
  if (!model || !voiceProvider) return null;
  return VOICE_MODEL_PROVIDER[model as z.infer<typeof voiceModel>] === voiceProvider ? model : null;
}

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

/**
 * The platform locale an agent locale runs on (ADR 0027). Identity for everything the
 * platform lists; `ar-AE` — which it does not — runs on `ar-SA`, its only Arabic. The
 * dialect is carried by the prompt (`dialects.ts`) and the voice, not by this.
 */
export function platformLanguage(code: AgentLanguage): RetellLanguage {
  return code === 'ar-AE' ? 'ar-SA' : code;
}

/**
 * What the agent's `language` is sent as: the main locale alone, or the explicit list
 * when the customer picked "also speaks" (ADR 0003 §6), mapped and de-duplicated — an
 * Emirati agent that also speaks Saudi Arabic is one platform locale, not two.
 */
export function platformLanguages(primary: AgentLanguage, extra: readonly AgentLanguage[]): RetellLanguage | RetellLanguage[] {
  const all = [...new Set([primary, ...extra].map(platformLanguage))];
  return extra.length > 0 && all.length > 1 ? all : all[0]!;
}

/**
 * The transcription mode for an agent: the tier's, except Arabic, which always runs
 * `accurate`. In the 26 Oct proof calls `fast` (10 ms end-of-speech) cut Saudi callers
 * off mid-sentence and logged noise as "unintelligible" turns; `accurate` (300 ms) did
 * neither, and Arabic phone numbers are dictated with pauses (ADR 0027).
 */
export function sttModeFor(primary: AgentLanguage, tierMode: TierStack['stt_mode']): TierStack['stt_mode'] {
  return primary.startsWith('ar-') ? 'accurate' : tierMode;
}
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
  /**
   * Transfer targets (§11) become Retell transfer_call tools. Phase 2 for the billing split.
   * The number is the tool's destination only; the model is shown the conditions, never
   * the digits (BUG-005).
   */
  transfers?: TransferTarget[];
}

/** One staff number to transfer to, and the brief's conditions that lead there. */
export interface TransferTarget {
  number: string;
  conditions: string[];
}

/** Agent-level settings. `webhookUrl` is always ours; callers cannot change it. */
export interface AgentSpec {
  name: string;
  llmId: string;
  voiceId: string;
  /** `null` clears a model stored by an earlier sync (see `voiceModelFor`). */
  voiceModel?: VoiceModel | null;
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
  /**
   * D3 Settings (QA-079): scrub `PII_CATEGORIES` after the call (`piiConfigFor`). False
   * sends an empty list, which is how a stored config is switched off; undefined leaves
   * whatever the platform holds.
   */
  piiRemoval?: boolean;
  sttMode?: TierStack['stt_mode'];
  timezone?: string;
}

/**
 * The agent's noise filter: the tier's, or the strongest one when the agent's `denoise`
 * add-on is on (QA-079, plan gate `denoise`) — it also drops voices in the background,
 * which is what a caller in a shop or a car needs.
 */
export function denoisingModeFor(denoise: boolean, tierMode: TierStack['denoising_mode']): TierStack['denoising_mode'] {
  return denoise ? 'noise-and-background-speech-cancellation' : tierMode;
}

type PiiConfig = NonNullable<Retell.AgentCreateParams['pii_config']>;

/**
 * What PII removal scrubs from the transcript and the recording (QA-079). The
 * identifiers a business never needs back from a phone call — card, bank, account and
 * government numbers, passwords and PINs, health ids, dates of birth.
 *
 * Deliberately **not** the caller's name, phone number, email or address. Taking a
 * message with exactly those is what most of these agents are for: the call page shows
 * them, `captured_checks` compares a captured number with what the caller said in the
 * transcript (`captured-phones.ts`), and a callback dials the caller back. Scrubbing them
 * would turn the agent's main output into "[redacted]".
 */
export const PII_CATEGORIES: PiiConfig['categories'] = [
  'ssn',
  'passport',
  'driver_license',
  'credit_card',
  'bank_account',
  'password',
  'pin',
  'medical_id',
  'date_of_birth',
  'customer_account_number',
];

/** `pii_config` for an agent; post-call is the only mode the platform has. */
export function piiConfigFor(on: boolean | undefined): PiiConfig | undefined {
  if (on === undefined) return undefined;
  return { mode: 'post_call', categories: on ? [...PII_CATEGORIES] : [] };
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

/** What W4 sends to a knowledge base: any mix of the three source kinds. The gateway converts files with the SDK. */
export interface KnowledgeSourcesInput {
  texts?: Array<{ title: string; text: string }>;
  urls?: string[];
  files?: Array<{ bytes: Buffer; filename: string; contentType: string }>;
}

/** The fields of Retell's phone number object the numbers module reads back. */
export type PhoneNumberFacts = Pick<
  Retell.PhoneNumberResponse,
  'phone_number' | 'phone_number_type' | 'phone_number_pretty' | 'nickname' | 'inbound_agents' | 'inbound_webhook_url' | 'area_code'
> & { country_code?: string; toll_free?: boolean };

/** A knowledge base as read back: status and the sources it holds. */
export type KnowledgeBaseFacts = Pick<Retell.KnowledgeBaseResponse, 'knowledge_base_id' | 'knowledge_base_name' | 'status' | 'knowledge_base_sources'>;
