import { describe, expect, it } from 'vitest';
import { nanpAreaCode, overlayCodes, purchaseAttempts } from './purchase-attempts';

describe('purchaseAttempts', () => {
  it('647: both carriers for 647, then the Toronto overlay, then any Canadian number', () => {
    const attempts = purchaseAttempts({ country: 'CA', areaCode: 647, tollFree: false });
    expect(attempts.slice(0, 2)).toEqual([
      { provider: 'twilio', areaCode: 647 },
      { provider: 'telnyx', areaCode: 647 },
    ]);
    expect(attempts.map((a) => a.areaCode).filter((c) => c !== undefined)).toEqual([647, 647, 416, 416, 437, 437, 942, 942]);
    expect(attempts.slice(-2)).toEqual([{ provider: 'twilio' }, { provider: 'telnyx' }]);
  });

  it('no area code, or toll-free: carriers only, never a code', () => {
    expect(purchaseAttempts({ country: 'CA', areaCode: null, tollFree: false })).toEqual([{ provider: 'twilio' }, { provider: 'telnyx' }]);
    expect(purchaseAttempts({ country: 'US', areaCode: 415, tollFree: true })).toEqual([{ provider: 'twilio' }, { provider: 'telnyx' }]);
  });

  it('a US code has no overlay table: the code, then any US number', () => {
    expect(purchaseAttempts({ country: 'US', areaCode: 415, tollFree: false })).toEqual([
      { provider: 'twilio', areaCode: 415 },
      { provider: 'telnyx', areaCode: 415 },
      { provider: 'twilio' },
      { provider: 'telnyx' },
    ]);
  });
});

describe('overlayCodes', () => {
  it('a code shared by two regions takes both, once each', () => {
    const codes = overlayCodes('CA', 587);
    expect(codes).toEqual([403, 825, 368, 780]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('an unknown code has none', () => {
    expect(overlayCodes('CA', 999)).toEqual([]);
  });
});

describe('nanpAreaCode (QA-076)', () => {
  it('reads the code a North American number was bought in', () => {
    expect(nanpAreaCode('+12365550100')).toBe('236');
    expect(nanpAreaCode('+16475550100')).toBe('647');
  });

  it('answers null for anything else', () => {
    expect(nanpAreaCode('+442071234567')).toBeNull();
    expect(nanpAreaCode('+1123')).toBeNull();
    expect(nanpAreaCode(null)).toBeNull();
  });
});
