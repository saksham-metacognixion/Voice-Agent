import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOC_SERIES, BankOfCanadaClient, parseValetObservations } from './bank-of-canada.client';

/*
 * ADR 0049: the Bank of Canada Valet API, series FXUSDCAD. The fixture is the API's real
 * answer for 3–17 Nov 2026, kept as it was served: it has a weekend in it and no row for
 * Wednesday 11 Nov (Remembrance Day), which is how a holiday looks from here.
 */

const fixture = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/fx/boc-fxusdcad-2026-11-17.json'), 'utf8')) as unknown;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('parseValetObservations', () => {
  it('reads FXUSDCAD from the real answer, newest first, as the text the Bank printed', () => {
    const rows = parseValetObservations(fixture);
    expect(rows[0]).toEqual({ observedOn: '2026-11-17', rate: '1.4291' });
    expect(rows.map((r) => r.observedOn)).toEqual([...rows.map((r) => r.observedOn)].sort().reverse());
    for (const row of rows) expect(row.rate).toMatch(/^\d\.\d{4}$/);
  });

  it('has no row for a weekend or a public holiday, and invents none', () => {
    const days = parseValetObservations(fixture).map((r) => r.observedOn);
    expect(days).not.toContain('2026-11-14'); // Saturday
    expect(days).not.toContain('2026-11-15'); // Sunday
    expect(days).not.toContain('2026-11-11'); // Remembrance Day
    expect(days).toContain('2026-11-10');
    expect(days).toContain('2026-11-12');
  });

  it('sorts whatever order the source answers in', () => {
    const rows = parseValetObservations({ observations: [{ d: '2026-11-12', FXUSDCAD: { v: '1.4255' } }, { d: '2026-11-17', FXUSDCAD: { v: '1.4291' } }, { d: '2026-11-13', FXUSDCAD: { v: '1.4257' } }] });
    expect(rows.map((r) => r.observedOn)).toEqual(['2026-11-17', '2026-11-13', '2026-11-12']);
  });

  it('drops an entry with a missing, empty, zero, negative or non-decimal rate', () => {
    const rows = parseValetObservations({
      observations: [
        { d: '2026-11-17', FXUSDCAD: { v: '' } },
        { d: '2026-11-16', FXUSDCAD: {} },
        { d: '2026-11-13' },
        { d: '2026-11-12', FXUSDCAD: { v: '0.0000' } },
        { d: '2026-11-10', FXUSDCAD: { v: '-1.4181' } },
        { d: '2026-11-09', FXUSDCAD: { v: 'n/a' } },
        { d: '2026-11-06', FXUSDCAD: { v: 1.4102 } },
        { d: '2026-11-05', FXUSDCAD: { v: '1.4098' } },
      ],
    });
    expect(rows).toEqual([{ observedOn: '2026-11-05', rate: '1.4098' }]);
  });

  it('drops an entry whose date is not a real calendar day', () => {
    const rows = parseValetObservations({ observations: [{ d: '2026-02-30', FXUSDCAD: { v: '1.4' } }, { d: '17 Nov 2026', FXUSDCAD: { v: '1.4' } }, { d: null, FXUSDCAD: { v: '1.4' } }] });
    expect(rows).toEqual([]);
  });

  it('reads only the series asked for', () => {
    expect(parseValetObservations({ observations: [{ d: '2026-11-17', FXEURCAD: { v: '1.6' } }] })).toEqual([]);
    expect(BOC_SERIES).toBe('FXUSDCAD');
  });

  it('answers an empty list for a window with no business day in it', () => {
    expect(parseValetObservations({ observations: [] })).toEqual([]);
  });

  it.each([null, undefined, 'error', 42, {}, { observations: 'none' }, { message: 'Series not found' }])('throws on a body that is not the documented shape (%j)', (body) => {
    expect(() => parseValetObservations(body)).toThrow(/observations/);
  });
});

describe('BankOfCanadaClient.recent', () => {
  const answer = (status: number, body: unknown) => vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });

  it('asks the Valet API for the series and returns the parsed rows', async () => {
    const fetchMock = answer(200, fixture);
    vi.stubGlobal('fetch', fetchMock);
    const rows = await new BankOfCanadaClient().recent();
    expect(rows[0]).toEqual({ observedOn: '2026-11-17', rate: '1.4291' });
    const [url, init] = fetchMock.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(url).toBe('https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=10');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads its base URL from FX_BOC_VALET_URL, so the source can be moved without a code change', async () => {
    const fetchMock = answer(200, fixture);
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('FX_BOC_VALET_URL', 'http://localhost:9997/valet/');
    await new BankOfCanadaClient().recent();
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('http://localhost:9997/valet/observations/FXUSDCAD/json?recent=10');
  });

  it.each([500, 502, 503, 404, 429])('throws on HTTP %i', async (status) => {
    vi.stubGlobal('fetch', answer(status, {}));
    await expect(new BankOfCanadaClient().recent()).rejects.toThrow(String(status));
  });

  it('throws on a timeout or a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })));
    await expect(new BankOfCanadaClient().recent()).rejects.toThrow(/timeout/);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(new BankOfCanadaClient().recent()).rejects.toThrow('fetch failed');
  });

  it('throws on a 200 that is not JSON or not the documented shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    await expect(new BankOfCanadaClient().recent()).rejects.toThrow(SyntaxError);
    vi.stubGlobal('fetch', answer(200, { message: 'maintenance' }));
    await expect(new BankOfCanadaClient().recent()).rejects.toThrow(/observations/);
  });
});
