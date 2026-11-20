import { describe, expect, it } from 'vitest';
import { foldForSearch, matchesSearch } from './search';

/*
 * W1's industry search (ADR 0039 §3). The labels are shown in English, Arabic or Quebec
 * French, so the match has to survive accents and case, and the untranslated slug is a
 * keyword so "real estate" still finds "Immobilier".
 */

describe('foldForSearch', () => {
  it('drops accents and case', () => {
    expect(foldForSearch('École de conduite')).toBe('ecole de conduite');
    expect(foldForSearch('ÉLECTRICITÉ')).toBe('electricite');
  });

  it('leaves Arabic letters as they are', () => {
    expect(foldForSearch('طب الأسنان')).toBe('طب الأسنان');
  });
});

describe('matchesSearch', () => {
  const dental = { label: 'Dental', keywords: ['dental'] };
  const school = { label: 'École de conduite', keywords: ['driving school'] };
  const arabic = { label: 'طب الأسنان', keywords: ['dental'] };

  it('matches everything on an empty or blank query', () => {
    expect(matchesSearch(dental, '')).toBe(true);
    expect(matchesSearch(dental, '   ')).toBe(true);
  });

  it('matches part of the label, whatever the case', () => {
    expect(matchesSearch(dental, 'dent')).toBe(true);
    expect(matchesSearch(dental, 'DENT')).toBe(true);
    expect(matchesSearch(dental, 'plumb')).toBe(false);
  });

  it('matches without the accent the label carries', () => {
    expect(matchesSearch(school, 'ecole')).toBe(true);
    expect(matchesSearch(school, 'École')).toBe(true);
  });

  it('matches a keyword when the label is in another language', () => {
    expect(matchesSearch(school, 'driving')).toBe(true);
    expect(matchesSearch(arabic, 'dental')).toBe(true);
    expect(matchesSearch(arabic, 'الأسنان')).toBe(true);
  });

  it('works with no keywords at all', () => {
    expect(matchesSearch({ label: 'Towing' }, 'tow')).toBe(true);
    expect(matchesSearch({ label: 'Towing' }, 'dental')).toBe(false);
  });
});
