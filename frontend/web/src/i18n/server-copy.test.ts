import { carrier as carrierEnum } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
// The server's own English, so a change there fails here instead of leaving a stale translation.
import { forwardingGuideFor } from '../../../../backend/api/src/modules/numbers/forwarding-guide';
import { PRICING_V1 } from '../../../../backend/db/prisma/seed-data/pricing-v1';
import { formatMoney } from '../wizard/plan-gates';
import { LOCALES, messages, setActiveLocale } from './index';
import { matchSource } from './server-copy';

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
