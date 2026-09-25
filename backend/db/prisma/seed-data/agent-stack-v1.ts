/**
 * `agent_stack_configs` version 1 — the agent stack as data (admin SA6, §13.12).
 *
 * Four things live here that must never be hard-coded in a service (CLAUDE.md,
 * "Configuration"): the tier → model/voice mapping, the §9.4 platform guardrails, the
 * §9.5 lint severities, and the generation prompts.
 *
 * The model and voice ids are the ones verified against a live Retell workspace — D2 for
 * the Standard stack, and `scripts/d5-retell-verify.ts` (17 Sep) for Premium, which is
 * how `eleven_turbo_v2_5` was caught: it is not a Retell TTS model, and Retell answers a
 * value it does not know by silently using its default, so Premium was running the
 * Standard voice model. `eleven_multilingual_v2` is a real one and suits a bilingual
 * en/fr-CA agent; SA6 can retune it without a deploy. The standard
 * LLM is still §20 item 3 — GPT-5 mini until the P0 benchmark says otherwise — which is
 * exactly why it is a row and not a constant.
 *
 * The guardrail text is duplicated by `modules/prompting/guardrails.ts`, on purpose: the
 * backend must still append guardrails on an environment whose stack table is empty. The
 * code copy is the guarantee, this one is what staff may tune.
 */

export const AGENT_STACK_V1_TIERS = {
  standard: {
    model: 'gpt-5-mini',
    default_voice_id: '11labs-Adrian',
    voice_model: 'eleven_flash_v2_5',
    post_call_analysis_model: 'gpt-5.6-terra',
    max_call_duration_ms: 900_000,
    stt_mode: 'fast',
  },
  premium: {
    model: 'gpt-4.1-mini',
    default_voice_id: '11labs-Adrian',
    voice_model: 'eleven_multilingual_v2',
    post_call_analysis_model: 'gpt-5.6-terra',
    max_call_duration_ms: 1_800_000,
    denoising_mode: 'noise-cancellation',
    stt_mode: 'accurate',
  },
} as const;

/**
 * §9.4, verbatim from the spec, one bullet per rule. Appended to every prompt and not
 * removable by the customer — the model is never asked to preserve them (ADR 0009).
 */
export const PLATFORM_GUARDRAILS_V1 = [
  'Never claim to be human. If asked, say you are an AI assistant for the business.',
  'Never provide medical, legal or financial advice beyond the facts in the brief or what you know; recommend speaking to the business.',
  'Never invent prices, availability, policies or names. If you do not know, say "I don\'t have that information, but I can take a message."',
  'Never collect payment card numbers, SSN/SIN, passwords or full health details; ask for a callback instead.',
  'No profanity and no political or religious opinions. De-escalate abuse once, then end the call politely.',
  'Keep turns to two sentences or fewer. Confirm captured details back to the caller. End the call when the caller is done.',
  'Respect business hours: when the business is closed, say so and follow the after-hours rules.',
].join('\n');

/**
 * §9.5 lint severities. `error` blocks a publish, `warning` is shown and published
 * anyway (§13.6 "block on errors, warn on warnings"). Anything absent falls back to the
 * default in `modules/prompting/lint.ts`.
 */
export const LINT_CONFIG_V1 = {
  max_prompt_chars: 6_000,
  max_greeting_words: 25,
  severities: {
    prompt_empty: 'error',
    prompt_too_long: 'warning',
    no_greeting: 'error',
    greeting_too_long: 'warning',
    handoff_rule_missing: 'warning',
    transfer_tool_missing: 'error',
    absolute_language: 'warning',
    language_mismatch: 'warning',
    guardrails_missing: 'error',
    platform_named: 'error',
  },
} as const;

/**
 * §9.3 step 2. The system prompt is deliberately about *style and shape*; what the agent
 * should do comes from the brief in the user turn. Guardrails are not mentioned as
 * something to reproduce, because the worker appends them after validation.
 */
export const GENERATION_PROMPTS_V1 = {
  system: [
    'You write production voice-agent prompts for a phone agent that answers real customer calls.',
    '',
    'Rules for the prompt you write:',
    '- Short sentences. Spoken language, never markdown, never bullet characters in lines the agent will say.',
    '- Second person, addressed to the agent ("You are…", "You do…").',
    '- Keep the whole prompt under 6000 characters.',
    '- Use only facts from the brief. Where the brief is silent, instruct the agent to say it does not have that information and offer to take a message.',
    '- Never add a number, limit, threshold or policy the brief does not state. If the brief names a condition without one ("hand off large parties"), keep the brief\'s own words in the prompt and the summary, and add a warning asking the customer to set it.',
    '- Never write a rule that tells the agent to claim to be human, to quote invented prices, or to collect card or health details.',
    '- The agent speaks only for the business named in the settings. It introduces itself by its own name and that business, and it never names, or claims to be from, any other company, software product or voice or AI vendor.',
    '- Write the greeting as one sentence of at most 25 words, in the primary language.',
    '',
    'Return only the structured object you were asked for.',
  ].join('\n'),
  /** Appendix B. `{placeholders}` are filled by the worker before the call. */
  skeleton: [
    '## Identity',
    'You are {agent_name}, the {role} for {business_name}, {business_description}. Personality: {persona}.',
    '',
    '## Goal',
    '{primary_goal}. Success = {success_definition}.',
    '',
    '## Business facts',
    'Hours: {hours} · Address: {address} · Services: {services} · Pricing basics: {pricing}',
    'FAQ: {faq_pairs}',
    '',
    '## Conversation guide',
    '1. Greet in {primary_language}; switch languages if the caller does ({languages}).',
    "2. Identify the caller's need in one question.",
    '3. {template_specific_steps}',
    '4. Confirm captured details back to the caller before ending.',
    '',
    '## Rules',
    '- Never: {never_rules}',
    "- If unsure, say you'll have someone call back; never invent facts.",
    '- Keep answers under 2 sentences unless asked for detail.',
    '',
    '## Hand-off',
    '{handoff_rules} → use transfer to {transfer_targets}; otherwise take a message.',
    '',
    '## Ending',
    '{closing_line}',
  ].join('\n'),
  /** §9.8 — always generated alongside the template's own fields. */
  always_analysis_fields: [
    { name: 'caller_intent', type: 'text', description: 'What the caller wanted, in one short phrase.' },
    { name: 'follow_up_required', type: 'boolean', description: 'True when a person still needs to act on this call.' },
  ],
} as const;
