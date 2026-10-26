import { describe, expect, it } from 'vitest';
import { CURATED_VOICES, curatedVoiceFor, sampleKeyOf } from './curated-voices';
import { isMultilingualFrom, languageRank, nativeLanguages } from './voice-languages';
import { sampleUrlOf } from './voices.service';

/*
 * ADR 0027. A voice we add to the platform comes back as `custom_voice_<this workspace>`
 * with no gender and no accent: the name the import gave it is all that says what it is.
 */

describe('curated voices', () => {
  it('are recognised by their platform name, exactly', () => {
    expect(curatedVoiceFor('Mona - Saudi Arabic')?.key).toBe('gulf-mona');
    expect(curatedVoiceFor('mona - saudi arabic')).toBeNull();
    expect(curatedVoiceFor('Mona')).toBeNull();
    expect(curatedVoiceFor(null)).toBeNull();
  });

  it('have unique keys and platform names, and a gender and an accent we can place', () => {
    expect(new Set(CURATED_VOICES.map((v) => v.key)).size).toBe(CURATED_VOICES.length);
    expect(new Set(CURATED_VOICES.map((v) => v.platformName)).size).toBe(CURATED_VOICES.length);
    for (const voice of CURATED_VOICES) {
      expect(['female', 'male']).toContain(voice.gender);
      expect(isMultilingualFrom(nativeLanguages({ accent: voice.accent }))).toBe(false);
    }
  });

  it('rank Emirati voices native for ar-AE and Saudi ones as the same language in another accent', () => {
    const emirati = nativeLanguages({ accent: 'Emirati' });
    const saudi = nativeLanguages({ accent: 'Saudi' });
    expect(languageRank(emirati, 'ar-AE')).toBe(2);
    expect(languageRank(saudi, 'ar-AE')).toBe(1);
    expect(languageRank(saudi, 'ar-SA')).toBe(2);
    expect(languageRank(saudi, 'en-US')).toBe(0);
  });

  it('file their clip under the curated key, so one recording serves every environment', () => {
    expect(sampleKeyOf({ retellVoiceId: 'custom_voice_abc', name: 'Fahad - Saudi' })).toBe('curated:gulf-fahad');
    expect(sampleKeyOf({ retellVoiceId: 'custom_voice_abc', name: 'Someone else' })).toBe('custom_voice_abc');
    expect(sampleKeyOf({ retellVoiceId: '11labs-Adrian' })).toBe('11labs-Adrian');
  });

  it('never fall back to the vendor clip under deny', () => {
    const row = { retellVoiceId: 'custom_voice_abc', name: 'Fahad - Saudi', sampleUrl: null, previewUrl: 'https://vendor.test/x.mp3' };
    expect(sampleUrlOf(row, 'deny') ?? '').not.toContain('vendor.test');
  });
});
