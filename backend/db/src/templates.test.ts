import { describe, expect, it } from 'vitest';
import { readTemplateFiles, templateFromRow, templateRowFrom, templatesDir } from './templates.js';

/*
 * The seed and the API's TemplatesService both go through these three functions. What
 * this file proves is that the catalogue in the repo is loadable through them, and that
 * the file → row → file round trip is lossless — so what SA6 edits in the table is the
 * same object the wizard would have read from disk.
 */

describe('templatesDir', () => {
  it('finds the repo catalogue from this package', () => {
    const dir = templatesDir({}, process.cwd());
    expect(dir).toBeTruthy();
  });

  it('honours TEMPLATES_DIR relative to the working directory, and ignores one without the catalogue', () => {
    expect(templatesDir({ TEMPLATES_DIR: 'does-not-exist' }, process.cwd())).toBe(
      templatesDir({}, process.cwd()),
    );
  });
});

describe('readTemplateFiles', () => {
  it('parses every shipped template through the zod schema', () => {
    const dir = templatesDir({}, process.cwd())!;
    const results = readTemplateFiles(dir);
    const failures = results.filter((r) => !r.ok);
    expect(failures, JSON.stringify(failures)).toEqual([]);
    expect(results.map((r) => (r.ok ? r.template.id : r.file))).toEqual(
      expect.arrayContaining([
        'receptionist',
        'appointment',
        'afterhours',
        'lead_qual',
        'faq_support',
        'restaurant',
        'custom',
      ]),
    );
  });
});

describe('templateRowFrom / templateFromRow', () => {
  it('round-trips every template through the table shape without loss', () => {
    const dir = templatesDir({}, process.cwd())!;
    for (const result of readTemplateFiles(dir)) {
      if (!result.ok) throw new Error(result.error);
      const row = templateRowFrom(result.template);
      const back = templateFromRow({
        ...row,
        rulesJson: JSON.parse(JSON.stringify(row.rulesJson)),
      });
      expect(back.error).toBeNull();
      expect(back.template).toEqual(result.template);
    }
  });

  it('reports rather than throws on a row that does not validate', () => {
    const back = templateFromRow({
      id: 'broken',
      name: 'Broken',
      industryTags: [],
      briefPrefillJson: { services: 'not-an-array' },
      stepsJson: [],
      analysisFieldsJson: [],
      rulesJson: {},
      defaultTier: 'standard',
      sampleAudioUrl: null,
      version: 1,
    });
    expect(back.template).toBeNull();
    expect(back.error).toMatch(/brief_prefill|steps/);
  });
});

// ADR 0039: what W2 shows before anyone types — §8 W2 #3 "Mon–Fri 9–5" and #8 "template defaults checked".
describe('the shipped brief prefills', () => {
  const templates = () =>
    readTemplateFiles(templatesDir({}, process.cwd())!).map((r) => {
      if (!r.ok) throw new Error(r.error);
      return r.template;
    });

  it('open Monday to Friday 09:00–17:00 and close the weekend', () => {
    for (const t of templates()) {
      const days = t.brief_prefill.business_hours?.days ?? {};
      expect(Object.keys(days).sort(), t.id).toEqual(['fri', 'mon', 'thu', 'tue', 'wed']);
      for (const intervals of Object.values(days)) expect(intervals, t.id).toEqual([{ open: '09:00', close: '17:00' }]);
    }
  });

  it('tick the presets their rules call for', () => {
    const presets = Object.fromEntries(templates().map((t) => [t.id, t.brief_prefill.never_do_presets]));
    expect(presets).toMatchObject({
      receptionist: ['no_prices', 'no_time_promises'],
      afterhours: ['no_medical_advice'],
      appointment: ['no_time_promises'],
      lead_qual: ['no_prices'],
      restaurant: ['no_time_promises'],
      faq_support: [],
      custom: [],
    });
  });

  it('do not repeat a ticked preset in the free text', () => {
    const sentences: Record<string, RegExp> = {
      no_prices: /never quote (final )?pric/i,
      no_medical_advice: /never give (safety or )?medical advice/i,
      no_time_promises: /never promise a (callback )?time|never confirm a slot/i,
    };
    for (const t of templates()) {
      for (const preset of t.brief_prefill.never_do_presets) expect(t.brief_prefill.never_do ?? '', `${t.id} ${preset}`).not.toMatch(sentences[preset]!);
    }
  });
});

