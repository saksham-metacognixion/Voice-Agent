import { describe, expect, it } from 'vitest';
import { knowledgeFactsOf, usedKnowledge } from './call-knowledge.service';
import { attribute, knowledgeUseOf, parseStoredUsage, storedSourceIds, summariseRetrievals, type KbSourceRef } from './kb-usage';

const FAQ = '0da459c1-2b1e-4c55-9d3f-111111111111';
const PAYMENTS = '7d2bc1e7-0000-4000-8000-222222222222';
const HOURS = '4fcadf44-0000-4000-8000-333333333333';
const SITE = '9a9a9a9a-0000-4000-8000-444444444444';
const sources: KbSourceRef[] = [
  { id: FAQ, type: 'file' },
  { id: PAYMENTS, type: 'file' },
  { id: HOURS, type: 'text' },
  { id: SITE, type: 'url' },
];

const entry = (contexts: string[], response_id = 1) => ({ response_id, kb_ids: ['knowledge_base_88cb10b77ab571ef'], language: 'en-IN', contexts, kb_config: { filterScore: 0.6, topK: 3 } });
const faq = '{FileName: 0da459c1-Bright_Smile_Dental_FAQ.txt}\nBRIGHT SMILE DENTAL CLINIC - PATIENT FAQ';
const payments = '{FileName: 7d2bc1e7-Bright_Smile_Dental_Insurance_and_Payments.txt}\nINSURANCE';
const hours = '{Title: Opening hours [4fcadf44]}\nMon–Fri 9–5';
const site = '{Site Title: Indian cuisine - Wikipedia}\nIndian cuisine consists of…';

describe('attribute', () => {
  it('names a file and a text by the row id our sync embedded, and a lone website', () => {
    expect(attribute(faq, sources)).toEqual({ source_id: FAQ, kind: 'file' });
    expect(attribute(hours, sources)).toEqual({ source_id: HOURS, kind: 'text' });
    expect(attribute(site, sources)).toEqual({ source_id: SITE, kind: 'url' });
  });

  it('keeps the kind but not an id it cannot be sure of', () => {
    expect(attribute(site, [...sources, { id: 'aaaaaaaa-0000-4000-8000-555555555555', type: 'url' }])).toEqual({ source_id: null, kind: 'url' });
    expect(attribute('{FileName: deadbeef-old.pdf}\n…', sources)).toEqual({ source_id: null, kind: 'file' });
    expect(attribute('no header at all', sources)).toEqual({ source_id: null, kind: 'unknown' });
  });
});

describe('summariseRetrievals (the platform file, as read on 27 Oct)', () => {
  it('counts look-ups, hits, and per-source hits once per look-up', () => {
    const file = [entry([payments, faq, faq], 1), entry([], 2), entry([faq], 3), entry([hours, site], 4)];
    expect(summariseRetrievals(file, sources)).toEqual({
      lookups: 4,
      hits: 3,
      sources: [
        { source_id: FAQ, kind: 'file', hits: 2 },
        { source_id: PAYMENTS, kind: 'file', hits: 1 },
        { source_id: HOURS, kind: 'text', hits: 1 },
        { source_id: SITE, kind: 'url', hits: 1 },
      ],
    });
  });

  it('records a call whose look-ups found nothing as zero hits, not as unknown', () => {
    expect(summariseRetrievals([entry([]), entry([])], sources)).toEqual({ lookups: 2, hits: 0, sources: [] });
  });

  it('is null for a file that is not the shape we know', () => {
    expect(summariseRetrievals({ items: [] }, sources)).toBeNull();
    expect(summariseRetrievals('oops', sources)).toBeNull();
  });

  it('gives the same answer on every replay', () => {
    const file = [entry([faq, payments]), entry([faq])];
    expect(summariseRetrievals(file, sources)).toEqual(summariseRetrievals(structuredClone(file), sources));
  });
});

describe('the stored shape and the wire', () => {
  it('reads back what it stored and lists the source ids to name', () => {
    const stored = { detail: 'complete', sources: [{ source_id: FAQ, kind: 'file', hits: 2 }, { source_id: null, kind: 'url', hits: 1 }] };
    expect(parseStoredUsage(stored)).toEqual(stored);
    expect(storedSourceIds(stored)).toEqual([FAQ]);
    expect(parseStoredUsage(null)).toEqual({ detail: 'count_only', sources: [] });
    expect(parseStoredUsage({ sources: [{ hits: -1 }, 'x'] })).toEqual({ detail: 'count_only', sources: [] });
  });

  it('is null for a call that never consulted what the agent knows', () => {
    expect(knowledgeUseOf(null, null, null, new Map())).toBeNull();
  });

  it('names sources at read time, and drops the id of one deleted since', () => {
    const stored = { detail: 'complete', sources: [{ source_id: FAQ, kind: 'file', hits: 2 }, { source_id: PAYMENTS, kind: 'file', hits: 1 }] };
    expect(knowledgeUseOf(3, 2, stored, new Map([[FAQ, 'Patient FAQ']]))).toEqual({
      lookups: 3,
      hits: 2,
      detail: 'complete',
      sources: [
        { source_id: FAQ, name: 'Patient FAQ', kind: 'file', hits: 2 },
        { source_id: null, name: null, kind: 'file', hits: 1 },
      ],
    });
  });

  it('reports a count-only call as such', () => {
    expect(knowledgeUseOf(4, null, { detail: 'count_only', sources: [] }, new Map())).toEqual({ lookups: 4, hits: null, detail: 'count_only', sources: [] });
  });
});

describe('knowledgeFactsOf', () => {
  it('reads the count and an https link from a lifecycle payload', () => {
    const payload = { event: 'call_analyzed', call: { call_id: 'c', latency: { knowledge_base: { num: 4, p50: 79 } }, knowledge_base_retrieved_contents_url: 'https://cdn.example/x.json?Expires=1' } };
    expect(knowledgeFactsOf(payload)).toEqual({ lookups: 4, url: 'https://cdn.example/x.json?Expires=1' });
    expect(usedKnowledge(payload.call)).toBe(true);
  });

  it('ignores a call without knowledge use and a link that is not https', () => {
    expect(knowledgeFactsOf({ call: { call_id: 'c', latency: { e2e: { num: 9 } } } })).toEqual({ lookups: null, url: null });
    expect(knowledgeFactsOf({ call: { knowledge_base_retrieved_contents_url: 'http://169.254.169.254/latest' } }).url).toBeNull();
    expect(usedKnowledge({})).toBe(false);
  });
});
