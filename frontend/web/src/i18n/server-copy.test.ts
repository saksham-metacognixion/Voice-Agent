import { readFileSync } from 'node:fs';
import { carrier as carrierEnum, lintRule } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
// The server's own English, so a change there fails here instead of leaving a stale translation.
import { forwardingGuideFor } from '../../../../backend/api/src/modules/numbers/forwarding-guide';
import { PRICING_V1 } from '../../../../backend/db/prisma/seed-data/pricing-v1';
import { formatMoney } from '../wizard/plan-gates';
import { LOCALES, messages, setActiveLocale } from './index';
import { matchSource, serverReasonKey } from './server-copy';

type Guide = Record<'steps' | 'disable_steps' | 'notes', string[]>;

describe('matchSource', () => {
  it('matches a line exactly, or with its one destination', () => {
    expect(matchSource('Dial *73.', 'Dial *73.')).toEqual({ destination: null });
    expect(matchSource('Dial +1 416 555 0100.', 'Dial {destination}.')).toEqual({ destination: '+1 416 555 0100' });
    expect(matchSource('Dial *74.', 'Dial *73.')).toBeNull();
    expect(matchSource('Press +1 416.', 'Dial {destination}.')).toBeNull();
  });
});

describe('the forwarding guide catalogue', () => {
  const en = messages.en.wizard.w6.guide.content as Record<string, Guide>;

  it.each([...carrierEnum.options])('%s: every server line has its English source, in order', (carrier) => {
    const server = forwardingGuideFor(carrier, null);
    for (const field of ['steps', 'disable_steps', 'notes'] as const) {
      expect(en[carrier]?.[field]?.length).toBe(server[field].length);
      server[field].forEach((line, i) => expect(matchSource(line, en[carrier]![field][i]!), `${carrier}.${field}.${i}`).not.toBeNull());
    }
  });

  it.each(LOCALES.filter((l) => l !== 'en'))('%s keeps the same lines and every dial code', (locale) => {
    const other = messages[locale].wizard.w6.guide.content as Record<string, Guide>;
    const codes = (s: string) => (s.match(/[*#][*#\d]*\d[*#\d]*/g) ?? []).sort().join(' ');
    for (const carrier of carrierEnum.options) {
      for (const field of ['steps', 'disable_steps', 'notes'] as const) {
        expect(other[carrier]?.[field]?.length, `${carrier}.${field}`).toBe(en[carrier]![field].length);
        en[carrier]![field].forEach((line, i) => expect(codes(other[carrier]![field][i]!), `${carrier}.${field}.${i}`).toBe(codes(line)));
      }
    }
  });
});

describe('pack copy', () => {
  it('has an English source for every seeded badge and description', () => {
    const sources = Object.values(messages.en.wizard.w7.packCopy as Record<string, string>);
    for (const pack of PRICING_V1.packs) {
      if (pack.badge) expect(sources).toContain(pack.badge);
      if (pack.description) expect(sources).toContain(pack.description);
    }
  });
});

describe('money on a right-to-left page', () => {
  it('reads left to right as one unit', () => {
    setActiveLocale('ar');
    try {
      expect(formatMoney(14900, 'USD')).toBe('⁦149 US$⁩');
    } finally {
      setActiveLocale('en');
    }
    expect(formatMoney(14900, 'USD')).toBe('$149');
  });
});

describe('lint rules (QA-022)', () => {
  // Every rule the API's lint can emit (`lintRule`, the zod enum its findings are parsed
  // with) has a label and a sentence in every language, so the D3 checks panel never
  // shows a raw `rules.platform_named` key.
  it.each([...LOCALES])('%s names every rule', (locale) => {
    const prompt = messages[locale].dashboard.agents.prompt as unknown as { rules: Record<string, string>; findings: Record<string, string>; ruleFallback: string };
    for (const rule of lintRule.options) {
      expect(prompt.rules[rule], `${locale} rules.${rule}`).toBeTruthy();
      expect(prompt.findings[rule], `${locale} findings.${rule}`).toBeTruthy();
    }
    expect(prompt.ruleFallback).toBeTruthy();
  });
});

describe('the server reasons catalogue (QA-010)', () => {
  // Where the API writes the customer-facing failure sentences W2 and W7 show: a job's
  // `customer_reason`, the `generation_failed` frame, an activation's error.
  const sources = [
    'modules/prompting/generation.worker.ts',
    'modules/prompting/prompting.service.ts',
    'modules/jobs/job-records.service.ts',
    'modules/admin/admin-jobs.service.ts',
    'modules/activation/activation-state.ts',
    'modules/activation/activation.service.ts',
    'modules/numbers/provisioning-error.ts',
  ].map((file) => readFileSync(new URL(`../../../../backend/api/src/${file}`, import.meta.url), 'utf8'));
  const en = messages.en.errors.serverReasons as Record<string, string>;

  it.each(Object.entries(en))('%s is still a sentence the API sends, word for word', (_key, line) => {
    expect(sources.some((source) => source.includes(line))).toBe(true);
  });

  it.each([...LOCALES])('%s has a line for every reason', (locale) => {
    const lines = messages[locale].errors.serverReasons as Record<string, string>;
    for (const key of Object.keys(en)) expect(lines[key], `${locale} ${key}`).toBeTruthy();
  });

  it('finds a reason by the server text, and nothing for free text', () => {
    expect(serverReasonKey("Couldn't generate — try again.")).toBe('generationDefault');
    expect(serverReasonKey(' This agent no longer exists. ')).toBe('agentMissing');
    expect(serverReasonKey('Something the catalogue has never seen.')).toBeNull();
  });
});
