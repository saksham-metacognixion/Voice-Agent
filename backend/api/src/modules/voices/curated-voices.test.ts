import { describe, expect, it } from 'vitest';
import { CURATED_VOICES, curatedPlatformNamesMatching, curatedVoiceFor, sampleKeyOf } from './curated-voices';
import { isMultilingualFrom, languageRank, nativeLanguages } from './voice-languages';
import { sampleUrlOf, toRow } from './voices.service';

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

  it('rank the Québécois voices native for fr-CA and nothing else', () => {
    const quebec = nativeLanguages({ accent: 'Canadian French' });
    expect(quebec).toEqual(['fr-CA']);
    expect(languageRank(quebec, 'fr-CA')).toBe(2);
    expect(languageRank(quebec, 'fr-FR')).toBe(1);
    expect(languageRank(quebec, 'en-US')).toBe(0);
    expect(CURATED_VOICES.filter((v) => v.accent === 'Canadian French').map((v) => v.key)).toEqual([
      'quebec-alexandre',
      'quebec-adam',
      'quebec-mathieu',
      'quebec-jeanne',
    ]);
    expect(curatedVoiceFor('Jeanne - Quebec French')?.gender).toBe('female');
    const quebecVoices = CURATED_VOICES.filter((v) => v.accent === 'Canadian French');
    // What W3 shows, the provider ids Pramod supplied, and the genders (17 Nov).
    expect(quebecVoices.map((v) => [v.name, v.providerVoiceId, v.gender])).toEqual([
      ['Alexandre Boutin', 'IPgYtHTNLjC7Bq7IPHrm', 'male'],
      ['Adam', '93nuHbke4dTER9x2pDwE', 'male'],
      ['Mathieu', 'ea8mX8XjQt6IYaKiIshC', 'male'],
      ['Jeanne Mance', 'K7gx0ylJdff0yjM2uVQS', 'female'],
    ]);
    for (const voice of quebecVoices) {
      expect(voice.provider).toBe('elevenlabs');
      expect(voice.publicUserId).toMatch(/^[0-9a-f]{64}$/);
      expect(`${voice.name} ${voice.platformName}`).not.toMatch(/eleven|retell/i);
      expect(sampleKeyOf({ retellVoiceId: 'custom_voice_any', name: voice.platformName })).toBe(`curated:${voice.key}`);
    }
  });

  it('cache a Québécois voice as Premium fr-CA with a clip of ours, whatever id the workspace gave it', () => {
    for (const voice of CURATED_VOICES.filter((v) => v.accent === 'Canadian French')) {
      // What list-voices sends for a voice we added: a workspace id, our name, no gender or accent.
      const row = toRow({ voice_id: 'custom_voice_of_this_workspace', voice_name: voice.platformName, provider: 'elevenlabs' });
      expect(row).toMatchObject({ tier: 'premium', gender: voice.gender, accent: 'Canadian French', languages: ['fr-CA'], isMultilingual: false });
      expect(sampleUrlOf({ ...row!, sampleUrl: null }, 'deny')).toMatch(/^\/samples\/voices\/[0-9a-f]{16}\.mp3$/);
    }
  });

  it('are found by the name W3 shows, not only the platform name the row is stored under', () => {
    expect(curatedPlatformNamesMatching('boutin')).toEqual(['Alexandre - Quebec French']);
    expect(curatedPlatformNamesMatching('Jeanne Mance')).toEqual(['Jeanne - Quebec French']);
    expect(curatedPlatformNamesMatching('  ')).toEqual([]);
    expect(curatedPlatformNamesMatching('nobody')).toEqual([]);
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
