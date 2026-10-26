import { describe, expect, it } from 'vitest';
import { choosePrimary } from './languages';

describe('choosePrimary (QA-011)', () => {
  it('moves an "also speaks" language to main in one change', () => {
    expect(choosePrimary('fr-CA', ['fr-CA', 'es-419'])).toEqual({ primary_language: 'fr-CA', languages: ['es-419'] });
  });

  it('leaves the extras alone when the new main language was not among them', () => {
    expect(choosePrimary('de-DE', ['fr-CA'])).toEqual({ primary_language: 'de-DE', languages: ['fr-CA'] });
  });
});
