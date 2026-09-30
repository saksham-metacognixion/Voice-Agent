import { createHash } from 'node:crypto';
import { VOICE_SAMPLE_FILES } from './voice-samples.generated';

/**
 * W3's clips of our own: one recording per catalogue voice, made by
 * `pnpm --filter @portal/api samples:voices` and shipped with the portal under
 * `frontend/web/public/samples/voices/`.
 *
 * They travel as files plus this manifest, not as `voices.sample_url` rows, because a row
 * would have to be written into every environment's database by hand, and staging's is a
 * private RDS instance nobody writes to outside a migration. The deploy ships the clips
 * (the portal's S3 sync) and the manifest (the API image) together.
 *
 * The URL is a path on the portal's own origin, which is where `<audio>` resolves it. The
 * file is named by a hash of the voice id, never the id: the platform's own voices are
 * `retell-<name>`, and a filename is a URL in a devtools panel (ADR 0020 §5).
 */
export const VOICE_SAMPLE_PATH = '/samples/voices/';

export function voiceSampleFile(voiceId: string): string {
  return `${createHash('sha256').update(voiceId).digest('hex').slice(0, 16)}.mp3`;
}

export function ourVoiceSample(voiceId: string): string | null {
  const file = VOICE_SAMPLE_FILES[voiceId];
  return file ? `${VOICE_SAMPLE_PATH}${file}` : null;
}
