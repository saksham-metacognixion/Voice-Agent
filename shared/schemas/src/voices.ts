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
  q: z.string().min(1).max(60).optional(),
});
export type VoicesQuery = z.infer<typeof voicesQuery>;

export const voiceResponse = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  gender: z.string().nullable(),
  accent: z.string().nullable(),
  languages: z.array(z.string()),
  /** Provider preview clip. Proxying it is D6 work; today the URL is public and static. */
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
