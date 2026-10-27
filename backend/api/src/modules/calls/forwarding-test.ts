/**
 * D17 "Test forwarding" (D4, spec p. 37: "we call their original number and verify it
 * lands") — the part the §13.9 hot path needs, pure.
 *
 * `ForwardingTestService` (numbers) rings the customer's own line *from* their Option B
 * number and writes `fwdtest:{e164}` for as long as the test may ring. If the carrier
 * forwarding is on, the call comes straight back to that number as an inbound call, and
 * the inbound path reads the marker in the MGET it already makes for `num:{e164}`. A match
 * is answered with a decline — a busy tone, no call object, no cost — so the test never
 * becomes the agent talking to itself, and the outbound leg ends `dial_busy`, billed zero.
 */

export interface ForwardingTestMarker {
  test_id: string;
  number_id: string;
  workspace_id: string;
  /** The customer's own line (`phone_numbers.forwarding_from`), E.164. */
  original: string;
}

/**
 * How long a test may ring before it is called `not_landed`. Long enough for "forward
 * when I don't answer", where the carrier rings the customer's phone for ~20–30 s first.
 */
export const FORWARDING_TEST_RING_MS = 75_000;

/** The marker outlives the ring window a little, so a late forward is still recognised. */
export const FORWARDING_TEST_MARKER_TTL_S = 90;

export function parseForwardingTestMarker(raw: string | null | undefined): ForwardingTestMarker | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ForwardingTestMarker>;
    if (
      typeof value?.test_id === 'string' &&
      typeof value.number_id === 'string' &&
      typeof value.workspace_id === 'string' &&
      typeof value.original === 'string'
    ) {
      return { test_id: value.test_id, number_id: value.number_id, workspace_id: value.workspace_id, original: value.original };
    }
  } catch {
    /* unreadable = no test running */
  }
  return null;
}

/**
 * Whether this inbound call is the test coming back, and how it showed up. The call is
 * placed *from* the number to the customer's line, so the forwarded leg arrives at the
 * number with our number as the caller on most carriers (`ours`), or with the customer's
 * line on carriers that pass the forwarding number instead (`original`, §11.2). Any other
 * caller is a real one and goes through the ordinary checks.
 *
 * `original` cannot tell the test from a real caller on such a carrier: every forwarded
 * call shows the customer's line. So a match is only a candidate — the inbound path
 * consumes the marker atomically, and only the call that consumed it is turned away. At
 * most one call per test, and a real caller only if they beat the test leg in.
 */
export function forwardingTestMatch(
  marker: ForwardingTestMarker | null,
  call: { numberId: string; from: string | null; to: string | null },
): 'ours' | 'original' | null {
  if (!marker || marker.number_id !== call.numberId || !call.from) return null;
  const from = digits(call.from);
  if (!from) return null;
  if (call.to && from === digits(call.to)) return 'ours';
  if (from === digits(marker.original)) return 'original';
  return null;
}

/** `+1 (450) 555-0123` and `14505550123` are the same line. */
function digits(value: string): string {
  return value.replace(/\D/g, '');
}
