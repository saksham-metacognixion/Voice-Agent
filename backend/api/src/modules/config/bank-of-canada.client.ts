import { Injectable } from '@nestjs/common';
import { parseFxRate } from '@portal/schemas';

/** One published rate: the business day it is for and the rate as the source printed it. */
export interface FxObservation {
  observedOn: string;
  rate: string;
}

/** The Bank of Canada series for the US dollar in Canadian dollars. */
export const BOC_SERIES = 'FXUSDCAD';
export const BOC_SOURCE = 'bank_of_canada';
const DEFAULT_VALET_URL = 'https://www.bankofcanada.ca/valet';
/** Days asked for. Ten business days span any run of weekends and holidays and refill history after an outage. */
const RECENT = 10;
const FETCH_TIMEOUT_MS = 10_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads the Valet API's answer for one series:
 *
 *     { "observations": [ { "d": "2026-11-17", "FXUSDCAD": { "v": "1.4291" } }, … ] }
 *
 * Returns the usable observations, newest first. A day the Bank did not publish
 * (weekend, holiday) is simply absent; an entry without a positive decimal rate or with a
 * date that is not a real calendar day is dropped, never guessed. Throws when the body is
 * not the documented shape, so a changed API reads as a failed refresh rather than as
 * "no new rate".
 */
export function parseValetObservations(body: unknown, series: string = BOC_SERIES): FxObservation[] {
  const observations = (body as { observations?: unknown } | null)?.observations;
  if (!Array.isArray(observations)) throw new Error('the exchange-rate source answered without an observations list');
  const out: FxObservation[] = [];
  for (const entry of observations) {
    const day = (entry as { d?: unknown } | null)?.d;
    const value = ((entry as Record<string, unknown> | null)?.[series] as { v?: unknown } | undefined)?.v;
    if (typeof day !== 'string' || !DAY_RE.test(day) || !isCalendarDay(day)) continue;
    if (typeof value !== 'string' || parseFxRate(value) === null) continue;
    out.push({ observedOn: day, rate: value });
  }
  return out.sort((a, b) => (a.observedOn < b.observedOn ? 1 : a.observedOn > b.observedOn ? -1 : 0));
}

function isCalendarDay(day: string): boolean {
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

/**
 * The one place the exchange-rate source is called. A public, unauthenticated GET: there
 * is no key to keep. `FX_BOC_VALET_URL` exists for a test double; the series is the
 * constant above because the stored pair (USD → CAD) is what it means.
 */
@Injectable()
export class BankOfCanadaClient {
  /** The name rows are stored and read under (`exchange_rates.source`). */
  source: string = BOC_SOURCE;
  readonly series = BOC_SERIES;

  private get baseUrl(): string {
    return (process.env.FX_BOC_VALET_URL ?? DEFAULT_VALET_URL).replace(/\/+$/, '');
  }

  /** The most recent published rates, newest first. Throws on a timeout, a non-200 or an unreadable body. */
  async recent(): Promise<FxObservation[]> {
    const response = await fetch(`${this.baseUrl}/observations/${this.series}/json?recent=${RECENT}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`the exchange-rate source answered ${response.status}`);
    return parseValetObservations(await response.json(), this.series);
  }
}
