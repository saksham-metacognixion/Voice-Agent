import type { AgentTier, VoiceResponse } from '@portal/schemas';

type Voice = Pick<VoiceResponse, 'id' | 'tier' | 'native'>;

/**
 * §8 W3 "if selected voice unsupported → auto-pick default and toast" (ADR 0039 §7), as a
 * pure decision over the list `GET /voices?lang=` returned (native voices first):
 *
 * - the current voice sounds native in the language → keep it (`null`);
 * - otherwise the first native voice at the agent's tier, else any native voice, else the
 *   first voice listed — a language no voice is native in still gets one;
 * - nothing listed, or the pick is the voice already chosen → `null`.
 *
 * The caller decides *when* to ask (a draft with no voice, or a language change made on
 * the screen), never on a mere reopen, so a voice someone chose is not swapped behind
 * their back.
 */
export function pickNativeVoice<V extends Voice>(voices: readonly V[], currentId: string | null, tier: AgentTier): V | null {
  const current = voices.find((v) => v.id === currentId);
  if (current?.native) return null;
  const candidate = voices.find((v) => v.native && v.tier === tier) ?? voices.find((v) => v.native) ?? voices[0];
  if (!candidate || candidate.id === currentId) return null;
  return candidate;
}
