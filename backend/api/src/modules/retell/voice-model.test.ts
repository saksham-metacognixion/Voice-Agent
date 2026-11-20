import { describe, expect, it } from 'vitest';
import { providerOfVoiceId, voiceModelFor } from './retell.types';

/*
 * The tier stack names one TTS model; W3 offers voices from every provider. Sending an
 * ElevenLabs model with a Cartesia voice is a 400 on update-agent (D9 wizard run), which
 * left every draft after W3 without a platform copy — untestable and unpublishable.
 */
describe('voiceModelFor', () => {
  it("sends the tier's model with a voice of the same provider", () => {
    expect(voiceModelFor('elevenlabs', 'eleven_flash_v2_5')).toBe('eleven_flash_v2_5');
    expect(voiceModelFor('cartesia', 'sonic-3')).toBe('sonic-3');
  });

  it("clears it (null) for another provider's voice, or an unknown one — omitting would keep a stored model", () => {
    expect(voiceModelFor('cartesia', 'eleven_flash_v2_5')).toBeNull();
    expect(voiceModelFor('platform', 'eleven_multilingual_v2')).toBeNull();
    expect(voiceModelFor(null, 'eleven_flash_v2_5')).toBeNull();
    expect(voiceModelFor('elevenlabs', undefined)).toBeNull();
  });

  it('reads the provider off a catalogue id when the voice is not cached', () => {
    expect(providerOfVoiceId('11labs-Adrian')).toBe('elevenlabs');
    expect(providerOfVoiceId('cartesia-Adrian')).toBe('cartesia');
    expect(providerOfVoiceId('custom_voice_28d16ee')).toBeNull();
  });
});
