import { describe, expect, it } from 'vitest';
import { choosePrimary, sortedLanguages } from './languages';

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
});
