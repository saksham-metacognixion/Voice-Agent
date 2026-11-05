import { describe, expect, it } from 'vitest';
import { pickNativeVoice } from './voice-pick';

/*
 * §8 W3 "if selected voice unsupported → auto-pick default and toast" (ADR 0039 §7).
 * The list is what `GET /voices?lang=` returns: the native voices first, flagged `native`.
 */

const v = (id: string, tier: 'standard' | 'premium', native: boolean) => ({ id, tier, native, name: id });
const LIST = [v('lea', 'premium', true), v('marc', 'standard', true), v('sophie', 'standard', true), v('ava', 'standard', false)];

describe('pickNativeVoice', () => {
  it('keeps a voice that already sounds native', () => {
    expect(pickNativeVoice(LIST, 'sophie', 'standard')).toBeNull();
    expect(pickNativeVoice(LIST, 'lea', 'standard')).toBeNull();
  });

  it('gives a draft with no voice the first native voice at its tier', () => {
    expect(pickNativeVoice(LIST, null, 'standard')?.id).toBe('marc');
    expect(pickNativeVoice(LIST, null, 'premium')?.id).toBe('lea');
  });

  it('replaces a voice that is not native in the new language', () => {
    expect(pickNativeVoice(LIST, 'ava', 'standard')?.id).toBe('marc');
  });

  it('falls back to any native voice when none is native at the tier', () => {
    const premiumOnly = [v('lea', 'premium', true), v('ava', 'standard', false)];
    expect(pickNativeVoice(premiumOnly, null, 'standard')?.id).toBe('lea');
  });

  it('falls back to the first voice when none is native at all', () => {
    const none = [v('ava', 'standard', false), v('ben', 'standard', false)];
    expect(pickNativeVoice(none, null, 'standard')?.id).toBe('ava');
  });

  it('changes nothing when the pick is the voice already chosen', () => {
    const none = [v('ava', 'standard', false), v('ben', 'standard', false)];
    expect(pickNativeVoice(none, 'ava', 'standard')).toBeNull();
  });

  it('picks nothing from an empty list', () => {
    expect(pickNativeVoice([], null, 'standard')).toBeNull();
    expect(pickNativeVoice([], 'ava', 'standard')).toBeNull();
  });

  it('treats a saved voice missing from the list as not native', () => {
    expect(pickNativeVoice(LIST, 'gone', 'standard')?.id).toBe('marc');
  });
});
