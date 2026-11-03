/**
 * A phone number for a log or an audit row: the country code and the last two digits.
 * Enough to tell two callers apart in an investigation; the full number stays on the
 * `calls` row it came from (D18 audit rows, the §13.9 country decline log).
 */
export function maskNumber(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, '');
  if (digits.length < 6) return '•'.repeat(digits.length);
  return `+${digits.slice(0, 1)}${'•'.repeat(digits.length - 3)}${digits.slice(-2)}`;
}
