import { describe, expect, it } from 'vitest';
import { choosePrimary, sortedLanguages, startingLanguage } from './languages';

describe('choosePrimary (QA-011)', () => {
  it('moves an "also speaks" language to main in one change', () => {
    expect(choosePrimary('fr-CA', ['fr-CA', 'es-419'])).toEqual({ primary_language: 'fr-CA', languages: ['es-419'] });
  });

  it('leaves the extras alone when the new main language was not among them', () => {
    expect(choosePrimary('de-DE', ['fr-CA'])).toEqual({ primary_language: 'de-DE', languages: ['fr-CA'] });
  });
});

describe('sortedLanguages (ADR 0027)', () => {
  it('offers both Gulf Arabics, every language once', () => {
    const all = sortedLanguages('en');
    expect(all).toContain('ar-SA');
    expect(all).toContain('ar-AE');
    expect(new Set(all).size).toBe(all.length);
  });

  it('puts them first for someone using the portal in Arabic, after the launch set otherwise', () => {
    expect(sortedLanguages('ar').slice(0, 2)).toEqual(['ar-SA', 'ar-AE']);
    const en = sortedLanguages('en');
    expect(en[0]).toBe('en-US');
    expect(en.indexOf('ar-SA')).toBe(en.indexOf('de-DE') + 1);
  });

  it('puts the French ones first, Quebec on top, for someone using the portal in French', () => {
    const fr = sortedLanguages('fr-CA');
    expect(fr.slice(0, 3)).toEqual(['fr-CA', 'fr-FR', 'en-US']);
    expect(new Set(fr).size).toBe(fr.length);
  });
});

describe('startingLanguage', () => {
  it('follows the workspace country', () => {
    expect(startingLanguage('US', 'en')).toBe('en-US');
    expect(startingLanguage('SA', 'en')).toBe('ar-SA');
    expect(startingLanguage('ae', 'ar')).toBe('ar-AE');
    expect(startingLanguage('XX', 'en')).toBe('en-US');
    expect(startingLanguage(null, 'fr-CA')).toBe('en-US');
  });

  it('starts a Canadian business on fr-CA only when the portal is in French', () => {
    expect(startingLanguage('CA', 'en')).toBe('en-US');
    expect(startingLanguage('CA', 'ar')).toBe('en-US');
    expect(startingLanguage('CA', 'fr-CA')).toBe('fr-CA');
    expect(startingLanguage('US', 'fr-CA')).toBe('en-US');
  });
});
