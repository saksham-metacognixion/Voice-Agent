import { z } from 'zod';
import { businessHours } from './business-hours.js';
import { e164, isoDateTime, paginationQuery, uuid } from './common.js';
import { agentStatus, agentTier, templateId, versionSource } from './enums.js';

/*
 * Agents, briefs, versions and the prompt contract (§9, §13.3, §13.5, §13.6, §16).
 *
 * Three shapes matter here and they are deliberately separate:
 *
 *   brief          what the customer fills in (W2, 13 fields) — `agent_versions.brief_json`
 *   generated…     what the LLM must hand back — validated before anything is persisted
 *   agentVersion…  what the API hands to the portal
 *
 * The prompt the customer edits is **never** the prompt Retell runs: the §9.4 platform
 * guardrails are appended by the backend after validation and cannot be sent in by a
 * client (see `promptUpdate` at the bottom, which carries only the editable body).
 */

// ---------------------------------------------------------------------------
// The brief (W2 — spec pp. 17–18)
// ---------------------------------------------------------------------------

/** W2 #9. `transfer` needs a number; the other two actions never do. */
export const handoffAction = z.enum(['transfer', 'take_message', 'read_message']);
export type HandoffAction = z.infer<typeof handoffAction>;

export const handoffRule = z
  .object({
    condition: z.string().min(1).max(200),
    action: handoffAction,
    transfer_number: e164.optional(),
  })
  .refine((rule) => rule.action !== 'transfer' || Boolean(rule.transfer_number), {
    message: 'A transfer rule needs a phone number to transfer to',
    path: ['transfer_number'],
  });
export type HandoffRule = z.infer<typeof handoffRule>;

export const faqPair = z.object({
  question: z.string().min(1).max(300),
  answer: z.string().min(1).max(1_000),
});

/** W2 #11 — three sliders, 0–1, plus free text. */
export const personality = z.object({
  /** 0 = formal, 1 = friendly. */
  formality: z.number().min(0).max(1).default(0.5),
  /** 0 = brief, 1 = chatty. */
  brevity: z.number().min(0).max(1).default(0.5),
  /** 0 = calm, 1 = energetic. */
  energy: z.number().min(0).max(1).default(0.5),
  notes: z.string().max(300).optional(),
});
export type Personality = z.infer<typeof personality>;

/**
 * W2 #13. "Never claim to be human" is enforced by a §9.4 guardrail whatever this says —
 * the choice only decides whether the agent volunteers it or waits to be asked.
 */
export const aiDisclosure = z.enum(['always', 'if_asked', 'never_volunteer']);
export type AiDisclosure = z.infer<typeof aiDisclosure>;

/**
 * Business documents (W2, ADR 0023) — a menu, a price list, the services a practice
 * offers — uploaded as a file, read into plain text by `POST /agents/:id/documents/extract`
 * and kept **in the brief**, so they are versioned with it like every other field.
 *
 * The text is not asked of the model: it is attached to the prompt verbatim, in code,
 * just before the §9.4 block (`runtimePrompt` in the API), so a price reaches the caller
 * exactly as the business wrote it. That is also why the budget is a total: every
 * character is in the prompt on every call.
 */
export const BRIEF_MAX_DOCUMENTS = 3;
export const BRIEF_DOCUMENTS_MAX_CHARS = 15_000;
/** The file itself, before extraction. The text is what counts against the budget. */
export const BRIEF_DOCUMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * A photo of the menu is what most restaurants have. It is read by the generation
 * model's vision (`PromptProvider.transcribeImage`), at build time only — never on a
 * call. The browser downsizes a photo before upload (`brief-documents.tsx`), so what
 * arrives is a JPEG a model can read, not a 12-megapixel original.
 */
export const BRIEF_DOCUMENT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const briefDocumentType = z.enum([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv',
  ...BRIEF_DOCUMENT_IMAGE_TYPES,
]);
export type BriefDocumentType = z.infer<typeof briefDocumentType>;
export const BRIEF_DOCUMENT_TYPES = briefDocumentType.options;
export type BriefDocumentImageType = (typeof BRIEF_DOCUMENT_IMAGE_TYPES)[number];
export function isImageDocumentType(type: string): type is BriefDocumentImageType {
  return (BRIEF_DOCUMENT_IMAGE_TYPES as readonly string[]).includes(type);
}

export const briefDocument = z.object({
  name: z.string().trim().min(1).max(120),
  content_type: briefDocumentType,
  text: z.string().min(1).max(BRIEF_DOCUMENTS_MAX_CHARS),
  /** The file held more text than the budget allowed; the tail was left out. */
  truncated: z.boolean().default(false),
});
export type BriefDocument = z.infer<typeof briefDocument>;

export const briefDocuments = z
  .array(briefDocument)
  .max(BRIEF_MAX_DOCUMENTS)
  .refine(
    (docs) => docs.reduce((sum, doc) => sum + doc.text.length, 0) <= BRIEF_DOCUMENTS_MAX_CHARS,
    {
      message: `Documents can hold ${BRIEF_DOCUMENTS_MAX_CHARS.toLocaleString('en-US')} characters in total`,
    },
  );

/** `POST /agents/:id/documents/extract` — the file travels as base64 in JSON, like W4's. */
export const extractDocumentRequest = z.object({
  name: z.string().trim().min(1).max(120),
  content_type: briefDocumentType,
  content_base64: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9+/=\r\n]+$/, 'Not base64'),
});
export type ExtractDocumentRequest = z.infer<typeof extractDocumentRequest>;

/** Nothing is stored: the portal adds this to the brief and the autosave keeps it. */
export const extractDocumentResponse = z.object({
  name: z.string(),
  content_type: briefDocumentType,
  text: z.string(),
  /** Characters in the whole file, before any cut to the budget. */
  chars: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type ExtractDocumentResponse = z.infer<typeof extractDocumentResponse>;

/**
 * `agent_versions.brief_json`. Every field is optional at rest — the wizard autosaves a
 * half-filled brief on every keystroke (W2 "Autosave, debounced 1.5 s") — and
 * `briefReadyForGeneration` below is what "complete enough to generate" means.
 */
export const brief = z.object({
  about_business: z.string().max(1_000).optional(),
  goal: z.string().max(800).optional(),
  business_hours: businessHours.optional(),
  address: z.string().max(200).optional(),
  services: z.array(z.string().min(1).max(60)).max(30).default([]),
  pricing: z.string().max(500).optional(),
  faqs: z.array(faqPair).max(20).default([]),
  never_do: z.string().max(500).optional(),
  handoff_rules: z.array(handoffRule).max(5).default([]),
  agent_name: z.string().min(2).max(30).optional(),
  personality: personality.optional(),
  anything_else: z.string().max(800).optional(),
  ai_disclosure: aiDisclosure.default('if_asked'),
  documents: briefDocuments.default([]),
});
export type Brief = z.infer<typeof brief>;

/**
 * W2: "Generate is disabled until 1 & 2 are valid." Fields 1 and 2 have a *minimum*
 * length in the spec (20 chars) that the at-rest schema cannot enforce, because an
 * autosave of three characters must still be storable. This is where it is enforced.
 */
export const briefReadyForGeneration = brief.extend({
  about_business: z.string().min(20, 'Tell us at least a sentence about the business').max(1_000),
  goal: z.string().min(20, 'Describe what a good call achieves').max(800),
});

/** All the transfer numbers the brief names, in order, deduplicated. */
export function transferTargets(value: Brief): string[] {
  const numbers = value.handoff_rules
    .filter((rule) => rule.action === 'transfer' && rule.transfer_number)
    .map((rule) => rule.transfer_number!);
  return [...new Set(numbers)];
}

// ---------------------------------------------------------------------------
// Templates (§9.2 — templates/*.json)
// ---------------------------------------------------------------------------

/**
 * One post-call analysis field (§9.8). Max 15 per agent, `name` is snake_case.
 *
 * A **discriminated union**, not a flat object with an optional `enum`, because the two
 * are not the same promise. Retell's `post_call_analysis_data` documents an enum field's
 * `choices` as "must be non empty array", so an enum field without choices is not a field
 * we can send — it is a payload that fails at `update-agent`, which on this path means a
 * publish that dies at the end of the wizard. Saying so in the type means
 * `toRetellAnalysisFields` reads `field.enum` without a fallback and the compiler agrees,
 * rather than a `?? []` quietly manufacturing the invalid array.
 *
 * The other three types carry no `enum` at all; zod strips a stray one rather than
 * failing, so an older row that carried an empty array on a text field still parses.
 */
const analysisFieldName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'snake_case, starting with a letter');
const analysisFieldDescription = z.string().min(1).max(300);

/** §9.8 enum choices. Non-empty is Retell's rule, not ours (see `analysisField`). */
export const analysisFieldChoices = z.array(z.string().min(1).max(60)).min(1).max(20);

export const analysisField = z.discriminatedUnion('type', [
  z.object({
    name: analysisFieldName,
    type: z.literal('enum'),
    description: analysisFieldDescription,
    enum: analysisFieldChoices,
  }),
  z.object({
    name: analysisFieldName,
    type: z.enum(['text', 'number', 'boolean']),
    description: analysisFieldDescription,
  }),
]);
export type AnalysisField = z.infer<typeof analysisField>;

export const analysisSchema = z.array(analysisField).max(15);

/**
 * The **lenient** shape, used for one thing only: parsing what the model returned
 * (`generatedPrompt.analysis_fields`).
 *
 * Provider output is untrusted input that is normalised before it becomes a version — it
 * is never stored or sent as-is — so an enum field the model forgot to give choices to
 * must not fail the whole generation. Rejecting it there would throw away a good
 * 1,500-token prompt over one of fifteen optional fields. `normaliseAnalysisFields` is
 * the gate that turns this into `AnalysisField`, dropping what it cannot repair and
 * reporting it onto the job, and nothing else accepts this shape.
 */
export const modelAnalysisField = z.object({
  name: analysisFieldName,
  type: z.enum(['text', 'number', 'boolean', 'enum']),
  description: analysisFieldDescription,
  enum: z.array(z.string().min(1).max(60)).max(20).optional(),
});
export type ModelAnalysisField = z.infer<typeof modelAnalysisField>;

export const modelAnalysisSchema = z.array(modelAnalysisField).max(15);

/**
 * One file in `templates/`. The shape is the §9.2 catalogue table turned into JSON:
 * brief prefill, conversation steps, analysis fields, default rules, tier and sample
 * audio, plus industry-specific example texts the wizard shows as placeholders.
 */
export const agentTemplate = z.object({
  id: templateId,
  name: z.string().min(1).max(60),
  /** One line under the card in W1. */
  tagline: z.string().min(1).max(120),
  best_for: z.string().min(1).max(200),
  industry_tags: z.array(z.string().min(1).max(40)).default([]),
  /** Pre-fills `brief_json` when the agent is created (W1 → "agent_versions v1"). */
  brief_prefill: brief,
  /** §9.2 STEPS, in order. Rendered into the prompt skeleton's conversation guide. */
  steps: z.array(z.string().min(1).max(200)).min(1).max(12),
  /** §9.2 CAPTURED → the starting post-call analysis schema (§9.8). */
  analysis_fields: analysisSchema,
  /** §9.2 DEFAULT RULES. Business-level, unlike the §9.4 platform guardrails. */
  rules: z.array(z.string().min(1).max(300)).default([]),
  default_tier: agentTier.default('standard'),
  /** Static asset played by "hear sample" in W1. No credits, no Retell. */
  sample_audio_url: z.string().max(300).nullable().default(null),
  /** Industry → placeholder copy for the W2 "About your business" box. */
  example_texts: z.record(z.string(), z.string().max(1_000)).default({}),
  version: z.number().int().min(1).default(1),
});
export type AgentTemplate = z.infer<typeof agentTemplate>;

/**
 * The W1 card list. Never exposes `brief_prefill` — that lands when the agent is created.
 * `example_texts` rides along so W2 can show the placeholder copy of the industry the
 * agent was made for, rather than one fixed example for every template.
 */
export const templateSummary = agentTemplate.pick({
  id: true,
  name: true,
  tagline: true,
  best_for: true,
  industry_tags: true,
  default_tier: true,
  sample_audio_url: true,
  example_texts: true,
  version: true,
});
export type TemplateSummary = z.infer<typeof templateSummary>;

// ---------------------------------------------------------------------------
// The LLM contract (§9.3 step 3)
// ---------------------------------------------------------------------------

export const briefCard = z.object({
  does: z.array(z.string().min(1).max(200)).max(10).default([]),
  doesnt: z.array(z.string().min(1).max(200)).max(10).default([]),
  handoff: z.array(z.string().min(1).max(200)).max(10).default([]),
});
export type BriefCard = z.infer<typeof briefCard>;

export const scenario = z.object({
  title: z.string().min(1).max(120),
  say_this: z.string().min(1).max(600),
});
export type Scenario = z.infer<typeof scenario>;

/**
 * Exactly what the model must return (§9.3 step 3), and the gate every generated prompt
 * passes before it can become a version (§12 of the D5 brief: "never blindly trust LLM
 * output").
 *
 * `prompt` carries the *business* prompt only. The §9.4 guardrails are appended by the
 * worker afterwards — the model is never asked to preserve them, which is the whole
 * reason ADR 0009 could pick the smaller model.
 */
export const generatedPrompt = z.object({
  prompt: z.string().min(50).max(20_000),
  greeting: z.string().min(1).max(500),
  closing: z.string().min(1).max(500),
  brief_card: briefCard,
  /**
   * Lenient on purpose: this is the model's raw answer, not a stored version.
   * `normaliseAnalysisFields` turns it into `AnalysisField[]` and drops what it cannot
   * repair, so a forgotten `enum` costs one field rather than the whole generation.
   */
  analysis_fields: modelAnalysisSchema,
  scenarios: z.array(scenario).max(8).default([]),
  /** The model's own notes back to the customer. Not the §9.5 lint, which is ours. */
  warnings: z.array(z.string().min(1).max(300)).max(10).default([]),
});
export type GeneratedPrompt = z.infer<typeof generatedPrompt>;

/**
 * §9.6 feedback patch. `changes: []` with an explanation is the correct answer when the
 * feedback conflicts with a guardrail ("I can't make the agent claim to be human") — so
 * an empty `changes` is valid, never an error.
 *
 * `updated_prompt` is therefore **optional**, and required only when something changed.
 * Asked for a prompt it was told not to rewrite, a model returns an empty string or omits
 * the field — which is the honest answer, and a schema that rejected it turned a correct
 * refusal into a failed job. Found by running the real model
 * (`pnpm --filter @portal/api bench:generation -- --feedback`).
 */
export const generatedPatch = z
  .object({
    /** Only the brief fields that changed. Merged over the base brief and re-validated. */
    updated_brief: brief.partial().default({}),
    /** Omitted or empty when `changes` is empty — there was nothing to rewrite. */
    updated_prompt: z.string().max(20_000).optional(),
    changes: z.array(z.string().min(1).max(300)).max(20).default([]),
    /** Why nothing changed. Expected whenever `changes` is empty. */
    explanation: z.string().max(600).optional(),
    greeting: z.string().min(1).max(500).optional(),
    closing: z.string().min(1).max(500).optional(),
  })
  .refine(
    (patch) => patch.changes.length === 0 || (patch.updated_prompt?.trim().length ?? 0) >= 50,
    {
      message: 'A patch that changed something must carry the full updated prompt',
      path: ['updated_prompt'],
    },
  );
export type GeneratedPatch = z.infer<typeof generatedPatch>;

// ---------------------------------------------------------------------------
// Prompt lint (§9.5)
// ---------------------------------------------------------------------------

export const lintRule = z.enum([
  'prompt_empty',
  'prompt_too_long',
  'no_greeting',
  'greeting_too_long',
  'handoff_rule_missing',
  'transfer_tool_missing',
  'absolute_language',
  'language_mismatch',
  'guardrails_missing',
  'platform_named',
]);
export type LintRule = z.infer<typeof lintRule>;

/**
 * `error` blocks a publish, `warning` is shown and published anyway (§13.6: "lint — block
 * on errors, warn on warnings"). The split per rule lives in the backend and is
 * overridable from `agent_stack_configs.lint_json` so it is tunable without a deploy.
 */
export const lintSeverity = z.enum(['error', 'warning']);
export type LintSeverity = z.infer<typeof lintSeverity>;

export const lintFinding = z.object({
  rule: lintRule,
  severity: lintSeverity,
  message: z.string().min(1).max(300),
  /** Which part of the version the finding is about: `prompt`, `greeting`, `brief.…`. */
  field: z.string().max(80).nullable().default(null),
});
export type LintFinding = z.infer<typeof lintFinding>;

export const lintResult = z.object({
  findings: z.array(lintFinding),
  /** False when any finding is an error — i.e. publish is blocked. */
  publishable: z.boolean(),
  /** Stamped so a stored `lint_json` can be told apart from one produced by later rules. */
  linted_at: isoDateTime,
});
export type LintResult = z.infer<typeof lintResult>;

// ---------------------------------------------------------------------------
// Requests (§16)
// ---------------------------------------------------------------------------

/** POST /agents {template_id, industry} — W1 Continue. */
export const createAgentRequest = z.object({
  template_id: templateId,
  industry: z.string().min(1).max(60).optional(),
  /** Defaults to the template name; D3 "+ New agent" lets the customer name it. */
  name: z.string().min(2).max(60).optional(),
});
export type CreateAgentRequest = z.infer<typeof createAgentRequest>;

/**
 * The agent-level settings a version carries (`agent_versions.settings_json`): tier,
 * voice, languages, duration ceiling, recording. They travel *with the version* for the
 * same reason the brief does — a version is "what the agent is", and what is on the
 * phone must be exactly what was published, not what was last typed into the Voice tab.
 *
 * The copy on `agents` (`agents.tier`, `agents.voice_id`, …) is the **live** copy: the
 * billing rate (`calls.rate` derives from `agents.tier`), the runtime cache and every
 * inbound decision read it, and only a publish writes it. Editing the draft changes
 * nothing a caller or the wallet can see until the version goes live.
 */
/**
 * The locales Retell accepts on an agent (`AgentCreateParams.language`).
 *
 * It lives here, in the deps-free schema package, for two reasons. The wizard's W3 picker
 * needs the list in the browser, and — the load-bearing one — `primary_language` used to
 * be `z.string().min(2).max(10)` and was then **cast** to Retell's closed union on the way
 * out. A cast is not a check: `"en"`, `"xx-XX"` or a typo passed validation, was stored on
 * the version, and only failed at `update-agent`, i.e. at publish, at the end of the
 * wizard. Validating here rejects it at `PATCH /agents/:id/draft` with a field error
 * instead, which is where the customer can still see what they typed.
 *
 * `multi` is deliberately **not** in this list: it is what the gateway sends when the
 * customer has picked at least one "also speaks" language (W3), never something they
 * choose. `retell.types.ts` asserts at compile time that this list stays a subset of the
 * SDK's union, so an SDK upgrade that drops a locale fails the build rather than a call.
 */
export const retellLanguage = z.enum([
  'en-US',
  'en-IN',
  'en-GB',
  'en-AU',
  'en-NZ',
  'de-DE',
  'es-ES',
  'es-419',
  'hi-IN',
  'fr-FR',
  'fr-CA',
  'ja-JP',
  'pt-PT',
  'pt-BR',
  'zh-CN',
  'ru-RU',
  'it-IT',
  'ko-KR',
  'nl-NL',
  'nl-BE',
  'pl-PL',
  'tr-TR',
  'vi-VN',
  'ro-RO',
  'bg-BG',
  'ca-ES',
  'th-TH',
  'da-DK',
  'fi-FI',
  'el-GR',
  'hu-HU',
  'id-ID',
  'no-NO',
  'sk-SK',
  'sv-SE',
  'lt-LT',
  'lv-LV',
  'cs-CZ',
  'ms-MY',
  'af-ZA',
  'ar-SA',
  'az-AZ',
  'bs-BA',
  'cy-GB',
  'fa-IR',
  'fil-PH',
  'gl-ES',
  'he-IL',
  'hr-HR',
  'hy-AM',
  'is-IS',
  'kk-KZ',
  'kn-IN',
  'mk-MK',
  'mr-IN',
  'ne-NP',
  'sl-SI',
  'sr-RS',
  'sw-KE',
  'ta-IN',
  'ur-IN',
  'yue-CN',
  'uk-UA',
]);
export type RetellLanguage = z.infer<typeof retellLanguage>;

export const agentSettings = z.object({
  tier: agentTier,
  primary_language: retellLanguage,
  /** "Also speaks" (W3), up to four. */
  languages: z.array(retellLanguage).max(4),
  voice_id: z.string().min(1).max(120).nullable(),
  voice_speed: z.number().min(0.8).max(1.2).nullable(),
  voice_temperature: z.number().min(0).max(1).nullable(),
  /** D3 Settings: 3–30 minutes. Also caps `max_call_duration_ms` on every call. */
  max_call_duration_s: z.number().int().min(180).max(1_800),
  recording_enabled: z.boolean(),
});
export type AgentSettings = z.infer<typeof agentSettings>;

/** The settings a fresh v1 starts with. Only the tier comes from the template (§9.2). */
export function defaultAgentSettings(tier: z.infer<typeof agentTier> = 'standard'): AgentSettings {
  return {
    tier,
    primary_language: 'en-US',
    languages: [],
    voice_id: null,
    voice_speed: null,
    voice_temperature: null,
    max_call_duration_s: 600,
    recording_enabled: true,
  };
}

/**
 * PATCH /agents/:id/draft — the W2/W3 autosave and the D3 Brief/Voice tabs.
 *
 * Every field is optional and only what is sent is written. `brief` is merged field by
 * field over the stored brief, so an autosave of one textarea cannot wipe the rest.
 *
 * `name` and `industry` are labels and land on the agent. Everything else that is not
 * the brief is an `agentSettings` field and lands on the **draft version**: it becomes
 * live, and starts to bill, only when that version is published.
 */
export const agentDraftPatch = z.object({
  name: z.string().min(2).max(60).optional(),
  industry: z.string().min(1).max(60).optional(),
  brief: brief.partial().optional(),
  tier: agentTier.optional(),
  primary_language: retellLanguage.optional(),
  languages: z.array(retellLanguage).max(4).optional(),
  voice_id: z.string().min(1).max(120).nullable().optional(),
  voice_speed: z.number().min(0.8).max(1.2).optional(),
  voice_temperature: z.number().min(0).max(1).optional(),
  /** D3 Settings: 3–30 minutes. Also caps `max_call_duration_ms` on every call. */
  max_call_duration_s: z.number().int().min(180).max(1_800).optional(),
  recording_enabled: z.boolean().optional(),
  analysis_fields: analysisSchema.optional(),
});
export type AgentDraftPatch = z.infer<typeof agentDraftPatch>;

/**
 * PUT /agents/:id/versions/:v/prompt — the Advanced editor (§9.1: "the raw prompt is
 * editable only in the dashboard under Advanced, with lint warnings").
 *
 * It carries the **editable body only**. There is no field here through which a client
 * could send, remove or replace the §9.4 guardrails: the backend strips whatever block
 * the text contains and appends the canonical one (§9.4 "appended, non-editable").
 */
export const promptUpdate = z.object({
  prompt: z.string().min(50).max(20_000),
  greeting: z.string().min(1).max(500).optional(),
  closing: z.string().min(1).max(500).optional(),
});
export type PromptUpdate = z.infer<typeof promptUpdate>;

/**
 * POST /agents/:id/versions/:v/lint — the Advanced editor's live lint (§9.5). A dry run
 * of exactly what `PUT …/prompt` would store, against version `v`'s brief and settings:
 * the guardrails are appended first, so `guardrails_missing` cannot fire on text the
 * customer is not allowed to contain anyway. Nothing is written.
 *
 * Unlike `promptUpdate` the prompt may be short or empty — `prompt_empty` is a finding
 * the editor wants to show, not a 422.
 */
export const lintRequest = z.object({
  prompt: z.string().max(20_000),
  greeting: z.string().max(500).nullable().optional(),
});
export type LintRequest = z.infer<typeof lintRequest>;

/** POST /agents/:id/generate. `regenerate` rewrites from the brief and keeps test feedback. */
export const generateRequest = z.object({
  mode: z.enum(['generate', 'regenerate']).default('generate'),
});
export type GenerateRequest = z.infer<typeof generateRequest>;

/** POST /agents/:id/feedback {text, base_version} — §9.6, free text 10–500 chars. */
export const feedbackRequest = z.object({
  text: z.string().min(10).max(500),
  base_version: z.number().int().min(1).optional(),
});
export type FeedbackRequest = z.infer<typeof feedbackRequest>;

/** POST /agents/:id/draft/select {version_no} — Undo, and "Restore as draft" in D3. */
export const selectVersionRequest = z.object({
  version_no: z.number().int().min(1),
});
export type SelectVersionRequest = z.infer<typeof selectVersionRequest>;

/** POST /agents/:id/publish {version_no} — §13.6. */
export const publishRequest = z.object({
  version_no: z.number().int().min(1).optional(),
});
export type PublishRequest = z.infer<typeof publishRequest>;

export const agentsQuery = paginationQuery.extend({
  status: agentStatus.optional(),
});
export type AgentsQuery = z.infer<typeof agentsQuery>;

// ---------------------------------------------------------------------------
// Responses (§16)
// ---------------------------------------------------------------------------

/**
 * D3 list row. No Retell identifiers — the customer never learns the platform (§13.1).
 *
 * `tier`, `primary_language`, `languages`, `voice_id`, `max_call_duration_s` and
 * `recording_enabled` are the **live** values — what is on the phone and what a call is
 * billed at. The draft's values are on `draft.settings` (see `agentDetail`).
 */
export const agentSummary = z.object({
  id: uuid,
  name: z.string(),
  template_id: templateId.nullable(),
  industry: z.string().nullable(),
  status: agentStatus,
  tier: agentTier,
  primary_language: z.string(),
  languages: z.array(z.string()),
  voice_id: z.string().nullable(),
  draft_version: z.number().int().nullable(),
  published_version: z.number().int().nullable(),
  /** True when the draft is ahead of the published version — D3's sticky bottom bar. */
  has_unpublished_changes: z.boolean(),
  numbers_attached: z.number().int(),
  max_call_duration_s: z.number().int(),
  recording_enabled: z.boolean(),
  created_at: isoDateTime,
});
export type AgentSummary = z.infer<typeof agentSummary>;

/** One row of `agent_versions`. Immutable once written (§9.9). */
export const agentVersionSummary = z.object({
  version_no: z.number().int(),
  source: versionSource,
  created_by: uuid.nullable(),
  created_at: isoDateTime,
  published_at: isoDateTime.nullable(),
  is_published: z.boolean(),
  is_draft: z.boolean(),
  /** §9.6 bullets, for the Versions table "notes/changes" column. */
  changes: z.array(z.string()).nullable(),
  has_prompt: z.boolean(),
});
export type AgentVersionSummary = z.infer<typeof agentVersionSummary>;

/** GET /agents/:id/versions/:v — everything the Brief tab and the Advanced drawer render. */
export const agentVersionDetail = agentVersionSummary.extend({
  brief: brief,
  /** The full prompt Retell runs, guardrails included. Read-only. */
  prompt_text: z.string().nullable(),
  /** The same prompt with the §9.4 block removed — what the Advanced editor may edit. */
  editable_prompt: z.string().nullable(),
  greeting: z.string().nullable(),
  closing: z.string().nullable(),
  brief_card: briefCard.nullable(),
  scenarios: z.array(scenario).nullable(),
  analysis_fields: analysisSchema.nullable(),
  feedback_text: z.string().nullable(),
  lint: lintResult.nullable(),
  /** The tier, voice, languages and limits this version runs with once published. */
  settings: agentSettings,
});
export type AgentVersionDetail = z.infer<typeof agentVersionDetail>;

/** GET /agents/:id — the D3 Overview tab. */
export const agentDetail = agentSummary.extend({
  draft: agentVersionDetail.nullable(),
  published: agentVersionDetail.nullable(),
});
export type AgentDetail = z.infer<typeof agentDetail>;

/**
 * POST /agents/:id/publish. Carries no provider identifiers: which Retell version the
 * publish produced is bookkeeping on `agent_versions`, never part of the contract.
 */
export const publishResponse = z.object({
  agent_id: uuid,
  version_no: z.number().int(),
  status: agentStatus,
  lint: lintResult,
  /** True when this publish found the version already live and changed nothing. */
  already_published: z.boolean(),
});
export type PublishResponse = z.infer<typeof publishResponse>;

/** GET /jobs/:id — the §16 fallback for clients that lost the SSE stream. */
export const jobStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type JobStatus = z.infer<typeof jobStatus>;

/**
 * What a customer may learn about a job's progress. An explicit whitelist, built from
 * `jobs.steps_json` field by field — never the ledger itself, which names the provider,
 * the model, the Retell sync and whatever an SDK put in an error message.
 */
export const jobProgress = z.object({
  agent_id: uuid.nullable(),
  mode: z.enum(['generate', 'regenerate', 'feedback']).nullable(),
  /** The version the work started from. */
  base_version: z.number().int().nullable(),
  /** The version the job wrote, once it has. */
  version_no: z.number().int().nullable(),
  /** §9.6: how many changes the patch made, and whether it refused (`changes: []`). */
  changes: z.number().int().nullable(),
  refused: z.boolean().nullable(),
  /** §9.6: the model's explanation when it refused. Meant for the customer. */
  explanation: z.string().nullable(),
  lint_findings: z.number().int().nullable(),
  /** §13.8 activation jobs only: where the workflow stands. Null on every other job type. */
  activation_status: z
    .enum(['pending', 'publishing', 'provisioning', 'binding', 'marking_live', 'live', 'failed'])
    .nullable()
    .default(null),
  activation_step: z
    .enum(['publish', 'provision', 'bind', 'mark_live', 'notify'])
    .nullable()
    .default(null),
  number_id: uuid.nullable().default(null),
  e164: z.string().nullable().default(null),
});
export type JobProgress = z.infer<typeof jobProgress>;

export const jobResponse = z.object({
  id: uuid,
  type: z.string(),
  status: jobStatus,
  progress: jobProgress,
  /** Customer-safe, set only when `status = failed`. The diagnostic detail stays server-side. */
  error: z.string().nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
export type JobResponse = z.infer<typeof jobResponse>;
