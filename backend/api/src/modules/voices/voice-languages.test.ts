import { describe, expect, it } from 'vitest';
import { isMultilingualFrom, languageMatches, languageRank, nativeLanguages } from './voice-languages';

/*
 * The bug this file pins: W3's "Main language" changed the query string and nothing else.
 *
 * `list-voices` carries no language field, so every cached row had `languages: []`, which
 * the cache read as "speaks everything" — `is_multilingual` true on all 302 rows, and a
 * `lang` filter that matched all of them however the customer set it.
 */

describe('nativeLanguages', () => {
  it('reads the accent when the catalogue gives no language', () => {
    expect(nativeLanguages({ languages: [], accent: 'British' })).toEqual(['en-GB']);
    expect(nativeLanguages({ languages: [], accent: 'French' })).toEqual(['fr-FR', 'fr-CA']);
    expect(nativeLanguages({ languages: null, accent: 'Mexican' })).toEqual(['es-MX']);
  });

  it('prefers what the provider sent, if it ever sends one', () => {
    expect(nativeLanguages({ languages: ['fr-CA', 'en-US'], accent: 'Canadian' })).toEqual(['fr-CA', 'en-US']);
  });

  it('normalises the accent it was given', () => {
    expect(nativeLanguages({ accent: '  american  ' })).toEqual(['en-US']);
    expect(nativeLanguages({ accent: 'Southern American' })).toEqual(['en-US']);
  });

  it('says nothing rather than something wrong for an accent it cannot place', () => {
    expect(nativeLanguages({ accent: 'Martian' })).toEqual([]);
    expect(nativeLanguages({ accent: null })).toEqual([]);
  });
});

describe('isMultilingualFrom', () => {
  it('is true only when we cannot name one native language', () => {
    expect(isMultilingualFrom(['en-US'])).toBe(false);
    expect(isMultilingualFrom(['en-IN', 'hi-IN'])).toBe(true);
    expect(isMultilingualFrom([])).toBe(true);
  });
});

describe('languageMatches', () => {
  it('matches on the base subtag, so fr-FR answers a request for fr-CA', () => {
    // The old exact-or-prefix rule failed exactly here: `fr-FR` is neither `fr-CA` nor a
    // prefix of it, so a Quebec customer matched no French voice at all.
    expect(languageMatches('fr-FR', 'fr-CA')).toBe(true);
    expect(languageMatches('en-GB', 'en-US')).toBe(true);
    expect(languageMatches('fr-CA', 'fr')).toBe(true);
    expect(languageMatches('es-MX', 'fr-CA')).toBe(false);
  });
});

describe('languageRank', () => {
  it('puts the same locale above the same language above everything else', () => {
    expect(languageRank(['fr-CA'], 'fr-CA')).toBe(2);
    expect(languageRank(['fr-FR'], 'fr-CA')).toBe(1);
    expect(languageRank(['en-US'], 'fr-CA')).toBe(0);
  });

  it('claims nothing for an accent it could not place', () => {
    expect(languageRank([], 'fr-CA')).toBe(0);
  });

  it('ranks nothing when no language was asked for', () => {
    expect(languageRank(['fr-CA'], undefined)).toBe(0);
  });
});
