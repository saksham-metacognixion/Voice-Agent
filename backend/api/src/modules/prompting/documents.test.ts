import { describe, expect, it } from 'vitest';
import type { BriefDocument } from '@portal/schemas';
import { DOCUMENTS_HEADING, documentsBlock, runtimePrompt, stripDocuments } from './documents';
import { GUARDRAIL_HEADING, stripGuardrails } from './guardrails';

/*
 * ADR 0023 — the W2 documents reach the platform verbatim, between the script and the
 * §9.4 block, and never end up stored in the prompt or shown in the Advanced editor.
 */

const SCRIPT =
  '## Identity\nYou are Marie, the host for Trattoria Nonna.\n\n## Goal\nTake reservations.';
const MENU: BriefDocument = {
  name: 'Dinner menu',
  content_type: 'application/pdf',
  text: 'Margherita $14\nCarbonara $16',
  truncated: false,
};
const PRICES: BriefDocument = {
  name: 'Prices',
  content_type: 'text/plain',
  text: 'Delivery $5',
  truncated: true,
};

describe('runtimePrompt', () => {
  it('is script, then documents, then the fixed rules', () => {
    const out = runtimePrompt(SCRIPT, { documents: [MENU, PRICES] });
    const script = out.indexOf('## Identity');
    const docs = out.indexOf(DOCUMENTS_HEADING);
    const rules = out.indexOf(GUARDRAIL_HEADING);
    expect(script).toBeGreaterThanOrEqual(0);
    expect(docs).toBeGreaterThan(script);
    expect(rules).toBeGreaterThan(docs);
    expect(out).toContain('### Dinner menu\nMargherita $14\nCarbonara $16');
    expect(out).toContain('### Prices\nDelivery $5\n(The document continues');
  });

  it('adds nothing without documents', () => {
    const out = runtimePrompt(SCRIPT, { documents: [] });
    expect(out).not.toContain(DOCUMENTS_HEADING);
    expect(out).toContain(GUARDRAIL_HEADING);
  });

  it('is idempotent: a prompt fed back in is not doubled', () => {
    const once = runtimePrompt(SCRIPT, { documents: [MENU] });
    const twice = runtimePrompt(once, { documents: [MENU] });
    expect(twice).toBe(once);
    expect(twice.split(DOCUMENTS_HEADING).length).toBe(2);
  });

  it('a re-upload replaces the block rather than appending to it', () => {
    const v1 = runtimePrompt(SCRIPT, { documents: [MENU] });
    const v2 = runtimePrompt(v1, { documents: [PRICES] });
    expect(v2).not.toContain('Margherita');
    expect(v2).toContain('Delivery $5');
  });
});

describe('stripDocuments / stripGuardrails', () => {
  it('the editor never sees the documents', () => {
    const out = runtimePrompt(SCRIPT, { documents: [MENU] });
    expect(stripDocuments(stripGuardrails(out))).toBe(SCRIPT);
  });

  it('documentsBlock is empty for no documents', () => {
    expect(documentsBlock([])).toBe('');
  });
});
