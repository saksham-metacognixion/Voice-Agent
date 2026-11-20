import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VOICE_SAMPLE_FILES } from './voice-samples.generated';
import { VOICE_SAMPLE_PATH, ourVoiceSample, voiceSampleFile } from './voice-samples';
import { sampleUrlOf } from './voices.service';

const SAMPLES_DIR = path.resolve(__dirname, '../../../../../frontend/web/public/samples/voices');

describe('voice samples shipped with the portal', () => {
  it('names a file by a hash, never by the voice id', () => {
    // The platform's own voices are `retell-<name>`; a filename is a URL in devtools.
    const file = voiceSampleFile('retell-Rita');
    expect(file).toMatch(/^[0-9a-f]{16}\.mp3$/);
    expect(file.toLowerCase()).not.toContain('retell');
    expect(voiceSampleFile('retell-Rita')).toBe(file);
  });

  it('has a file on disk for every manifest entry, named as the hash says', () => {
    for (const [id, file] of Object.entries(VOICE_SAMPLE_FILES)) {
      expect(file).toBe(voiceSampleFile(id));
      expect(readFileSync(path.join(SAMPLES_DIR, file)).length).toBeGreaterThan(1000);
    }
  });

  it('prefers a row of ours, then the shipped clip, and the vendor clip only under allow', () => {
    const [id] = Object.keys(VOICE_SAMPLE_FILES);
    if (id) {
      const vendor = { retellVoiceId: id, sampleUrl: null, previewUrl: 'https://vendor.test/x.mp3' };
      expect(sampleUrlOf(vendor, 'deny')).toBe(`${VOICE_SAMPLE_PATH}${VOICE_SAMPLE_FILES[id]}`);
      expect(sampleUrlOf(vendor, 'allow')).toBe(ourVoiceSample(id));
      expect(sampleUrlOf({ ...vendor, sampleUrl: 'https://cdn.test/ours.mp3' }, 'deny')).toBe('https://cdn.test/ours.mp3');
    }
    const unknown = { retellVoiceId: 'no-such-voice', sampleUrl: null, previewUrl: 'https://vendor.test/x.mp3' };
    expect(sampleUrlOf(unknown, 'deny')).toBeNull();
    expect(sampleUrlOf(unknown, 'allow')).toBe('https://vendor.test/x.mp3');
  });
});
