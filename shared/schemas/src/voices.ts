import { z } from 'zod';
import { isoDateTime } from './common.js';
import { agentTier } from './enums.js';

/*
 * Voices (W3, §13.11 `voice-cache`, §16).
 *
 * The `voices` table is a global read-only projection of Retell's catalogue, refreshed
 * daily. Customer-facing copy never says "TTS" or names a provider (CLAUDE.md, Retell
 * isolation): the response carries a provider string because W3's filters need to group
 * by it, and the portal renders it as the voice family, not as a vendor.
 */

/** GET /voices?lang=&gender=&tier=&multilingual= */
export const voicesQuery = z.object({
  /** BCP-47 or a bare language subtag: `en`, `en-US`, `fr-CA`. Matched on the prefix. */
  lang: z.string().min(2).max(10).optional(),
  gender: z.enum(['male', 'female', 'neutral']).optional(),
  tier: agentTier.optional(),
  multilingual: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  /**
   * `true` keeps only the voices whose own accent is native to `lang` (W3's "Native
   * accents only"). Without it every voice is returned — the stacks behind them all
   * speak every locale we offer — with the native ones first and flagged.
   */
  native: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  q: z.string().min(1).max(60).optional(),
});
export type VoicesQuery = z.infer<typeof voicesQuery>;

export const voiceResponse = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  gender: z.string().nullable(),
  accent: z.string().nullable(),
  /**
   * The locales this voice sounds native in, derived from its accent. The catalogue
   * itself carries no language field (`list-voices` returns accent, gender and age only),
   * so this is the only language signal there is.
   */
  languages: z.array(z.string()),
  /**
   * Does this voice sound native in the `lang` that was asked for? False whenever no
   * `lang` was given. It is a property of the request, not of the voice, and it is what
   * W3 groups the picker by — every other voice can still speak that language, with its
   * own accent.
   */
  native: z.boolean(),
  /**
   * A clip of this voice we are willing to play. Null when there is none: the platform
   * has no text-to-speech route (ADR 0003 §9), and its own catalogue clips name the
   * vendor aloud, so they are withheld wherever `VOICE_VENDOR_SAMPLES` says `deny`.
   */
  preview_url: z.string().nullable(),
  tier: agentTier,
  is_multilingual: z.boolean(),
  updated_at: isoDateTime,
});
export type VoiceResponse = z.infer<typeof voiceResponse>;

export const voicesResponse = z.object({
  items: z.array(voiceResponse),
  /** When the cache was last refreshed. W3 shows a banner if it is stale (spec p. 22). */
  refreshed_at: isoDateTime.nullable(),
  stale: z.boolean(),
});
export type VoicesResponse = z.infer<typeof voicesResponse>;

/** POST /voices/:id/preview {text} — "Hear my greeting". Rate-limited, never billed. */
export const voicePreviewRequest = z.object({
  text: z.string().min(1).max(300).optional(),
});
export type VoicePreviewRequest = z.infer<typeof voicePreviewRequest>;

export const voicePreviewResponse = z.object({
  voice_id: z.string(),
  /** `sample` = the provider's fixed clip; `synthesized` = spoken from `text` (Phase 2). */
  kind: z.enum(['sample', 'synthesized']),
  audio_url: z.string(),
  /** Echoed back so the player can caption what is being said. */
  text: z.string().nullable(),
  expires_at: isoDateTime.nullable(),
});
export type VoicePreviewResponse = z.infer<typeof voicePreviewResponse>;
