/**
 * `retell_cost_inputs` version 1 — what the voice platform charges us, for the SA5 margin
 * check and COGS estimates (admin §5, ADR 0038). US cents. Every figure is either on the
 * platform's pricing page as read on 4 Nov 2026 or on a bill (`call_cost`) of a real call
 * (ADR 0037 §2); nothing here is an estimate. Where the bill and the page disagree, the
 * bill wins, because it is what we pay.
 *
 * Staff own the table after this: a fresh environment gets it, and an environment whose
 * latest row is not in this shape gets it as a new version (`pnpm db:seed`). A row in this
 * shape is never touched.
 */
export const RETELL_COSTS_V1 = {
  // Page and bill agree (ADR 0037 §2: 0.0916667 ¢/s).
  voice_engine_cents_per_min: 5.5,
  tts_cents_per_min: {
    // Page, 4 Nov: Retell platform voices, Cartesia, Minimax, Fish, OpenAI, Inworld.
    platform: 1.5,
    cartesia: 1.5,
    minimax: 1.5,
    fish_audio: 1.5,
    openai: 1.5,
    inworld: 1.5,
    // Page, 4 Nov; Flash also on the bill (ADR 0037 §2: 0.0666667 ¢/s).
    'elevenlabs:eleven_flash_v2': 4.0,
    'elevenlabs:eleven_flash_v2_5': 4.0,
    // Page, 4 Nov: Multilingual v2 is $0.06, not the $0.040 §4.3 assumes for Premium.
    'elevenlabs:eleven_multilingual_v2': 6.0,
    'elevenlabs:eleven_v3': 10.0,
    // An ElevenLabs voice with no model named runs the platform's default, priced as Flash.
    elevenlabs: 4.0,
  },
  llm_cents_per_min: {
    // Page, 4 Nov, standard (not fast) tier. GPT-5 mini and GPT-4.1 mini also on bills (ADR 0037 §1).
    'gpt-4.1': 4.5,
    'gpt-4.1-mini': 1.28,
    'gpt-4.1-nano': 0.32,
    'gpt-5-mini': 0.8,
    'claude-4.5-haiku': 2.5,
  },
  telephony_cents_per_min: {
    // Page and bill agree for the US (ADR 0037 §2: 0.025 ¢/s).
    US: 1.5,
    // The page says $0.015; every Canadian call on the bill was $0.030 (ADR 0037 §2).
    CA: 3.0,
  },
  // Page and bill agree (ADR 0037 §2).
  knowledge_base_cents_per_min: 0.5,
  analysis_cents_per_call: {
    // The bill only (ADR 0037 §2: `gpt_5_6_terra_text_testing`, flat 2.08 ¢); the page lists no analysis charge.
    'gpt-5.6-terra': 2.08,
  },
  monthly_cents: {
    // Page, 4 Nov: $2 per bought number; $8 per concurrency slot past 20; $8 per knowledge base past 10.
    phone_number: 200,
    concurrency_slot: 800,
    knowledge_base: 800,
  },
  // Admin §5 / SA5: "configurable floor (default 35%)".
  margin_floor_pct: 35,
} as const;
