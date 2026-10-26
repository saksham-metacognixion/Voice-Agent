import { z } from 'zod';
import { isoDateTime, paginationQuery, uuid } from './common.js';
import { agentTier, declineReason } from './enums.js';

/** `calls.channel` / `calls.direction` / `calls.status` (§15). */
export const callChannel = z.enum(['phone', 'web']);
export type CallChannel = z.infer<typeof callChannel>;

export const callDirection = z.enum(['inbound', 'outbound']);
export type CallDirection = z.infer<typeof callDirection>;

export const callStatus = z.enum(['registered', 'in_progress', 'ended', 'analyzed', 'declined']);
export type CallStatus = z.infer<typeof callStatus>;

/**
 * What the customer sees in D2. A declined call (§13.9) is shown as "Missed" — the caller
 * never reached the agent — so `missed` is accepted as a filter and returned as the display
 * status; the stored status stays `declined`.
 */
export const callDisplayStatus = z.enum(['registered', 'in_progress', 'ended', 'analyzed', 'missed']);
export type CallDisplayStatus = z.infer<typeof callDisplayStatus>;

/** D2 sort columns. Whatever the column, the order is made total with `created_at` and `id`. */
export const callSort = z.enum(['started_at', 'duration_s', 'credits_charged']);
export type CallSort = z.infer<typeof callSort>;

export const sortOrder = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof sortOrder>;

/** The D2 filters alone — what `GET /calls` and `POST /calls/export` have in common. */
export const callFilters = z.object({
  status: callDisplayStatus.optional(),
  channel: callChannel.optional(),
  direction: callDirection.optional(),
  agent_id: uuid.optional(),
  number_id: uuid.optional(),
  /** ISO 8601 bounds on `started_at`, inclusive `from`, exclusive `to`. */
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  /** Query strings are text; `z.coerce.boolean()` would read "false" as true. */
  is_test: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** `true` = marked handled, `false` = still to do. */
  handled: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type CallFilters = z.infer<typeof callFilters>;

/** GET /calls (filters) — §16. Everything optional; unknown values are a 422, never a 500. */
export const callsQuery = paginationQuery.merge(callFilters).extend({
  sort: callSort.default('started_at'),
  order: sortOrder.default('desc'),
});
export type CallsQuery = z.infer<typeof callsQuery>;

/**
 * PATCH /calls {ids, handled} — the D2 bulk "Mark handled". One statement, not one
 * request per row; ids from another workspace are simply not matched (RLS), and the
 * answer says how many rows changed so the UI can tell a partial match from a full one.
 */
export const callsBulkPatch = z.object({
  ids: z.array(z.string().min(1).max(120)).min(1).max(200),
  handled: z.boolean(),
});
export type CallsBulkPatch = z.infer<typeof callsBulkPatch>;

export const callsBulkResponse = z.object({ updated: z.number().int() });
export type CallsBulkResponse = z.infer<typeof callsBulkResponse>;

/**
 * POST /calls/export — a CSV of the calls matching the filters (the current D2 view), or
 * of `ids` when the customer selected rows. Streams `text/csv`; the row cap keeps one
 * export from holding a connection for a workspace's whole history.
 */
export const callsExportRequest = callFilters.extend({
  ids: z.array(z.string().min(1).max(120)).max(200).optional(),
  sort: callSort.default('started_at'),
  order: sortOrder.default('desc'),
});
export type CallsExportRequest = z.infer<typeof callsExportRequest>;

/** The most rows one export may carry. */
export const CALLS_EXPORT_MAX_ROWS = 10_000;

/** One row of D2. No Retell identifiers beyond the call id, and no COGS (`retell_cost_cents` is staff-only). */
export const callSummary = z.object({
  id: z.string(),
  agent_id: uuid.nullable(),
  agent_version: z.number().int().nullable(),
  number_id: uuid.nullable(),
  channel: callChannel,
  direction: callDirection,
  is_test: z.boolean(),
  from_number: z.string().nullable(),
  to_number: z.string().nullable(),
  started_at: isoDateTime.nullable(),
  ended_at: isoDateTime.nullable(),
  duration_s: z.number().int().nullable(),
  disconnection_reason: z.string().nullable(),
  tier: agentTier,
  /** Credits per minute captured at call_started (§14.2). */
  rate: z.number(),
  config_version: z.number().int().nullable(),
  credits_charged: z.number().nullable(),
  status: callDisplayStatus,
  decline_reason: declineReason.nullable(),
  outcome: z.string().nullable(),
  handled_at: isoDateTime.nullable(),
  note: z.string().nullable(),
  has_recording: z.boolean(),
  /**
   * `analysis_json.user_sentiment` as the platform wrote it (`Positive`, `Neutral`,
   * `Negative`, `Unknown`), for the D2 list's mood column (spec p. 34). Null until
   * `call_analyzed` arrives.
   */
  sentiment: z.string().nullable(),
  created_at: isoDateTime,
});
export type CallSummary = z.infer<typeof callSummary>;

/**
 * A captured field that holds a phone number (§9.8), recognised by its name: `phone`,
 * `callback_number`, `mobile`, `contact_number`… Read on the name's words, not its
 * letters, so `excellence_score` is not a `cell`.
 */
export function isPhoneFieldName(name: string): boolean {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  const has = (w: string) => words.includes(w);
  return (
    ['phone', 'telephone', 'tel', 'mobile', 'cell', 'callback', 'whatsapp'].some(has) ||
    (has('call') && has('back')) ||
    (has('contact') && has('number'))
  );
}

/**
 * The server's check of one captured phone number against the call itself.
 *
 * `mismatch` — its digits are not a sequence the caller said (nor the caller id): the
 * voice agent or the analysis changed them, as in the 26 Oct call where nine spoken
 * digits came back as ten. `invalid` — the caller's digits, but not a complete number
 * for the workspace's country or the agent's languages. `heard` is what the caller did
 * say, the phone-length digit runs of their own turns, so staff can call the right one.
 */
export const capturedPhoneStatus = z.enum(['ok', 'mismatch', 'invalid']);
export type CapturedPhoneStatus = z.infer<typeof capturedPhoneStatus>;

export const capturedPhoneCheck = z.object({
  field: z.string(),
  value: z.string(),
  status: capturedPhoneStatus,
  /** Digits in `value`. */
  digits: z.number().int(),
  heard: z.array(z.string()),
});
export type CapturedPhoneCheck = z.infer<typeof capturedPhoneCheck>;

/** GET /calls/:id — the D2 detail adds transcript and analysis. */
export const callDetail = callSummary.extend({
  transcript_text: z.string().nullable(),
  transcript_json: z.unknown().nullable(),
  analysis_json: z.unknown().nullable(),
  /**
   * One entry per captured phone field (`isPhoneFieldName`), checked against the
   * transcript. Defaults to empty so a portal deployed ahead of the API still parses.
   */
  captured_checks: z.array(capturedPhoneCheck).default([]),
});
export type CallDetail = z.infer<typeof callDetail>;

/** GET /calls/:id/recording — a signed, expiring URL the browser can play directly (§17). */
export const recordingResponse = z.object({
  url: z.string(),
  expires_at: isoDateTime,
});
export type RecordingResponse = z.infer<typeof recordingResponse>;

/** GET /stats?range=today|7d|30d|custom (§16, D1 Home). */
export const statsRange = z.enum(['today', '7d', '30d', 'custom']);
export type StatsRange = z.infer<typeof statsRange>;

export const statsQuery = z
  .object({
    range: statsRange.default('7d'),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
  })
  .refine((q) => q.range !== 'custom' || (q.from && q.to), {
    message: 'from and to are required when range is custom',
    path: ['from'],
  })
  .refine((q) => !(q.from && q.to) || new Date(q.from).getTime() < new Date(q.to).getTime(), {
    message: 'from must be before to',
    path: ['to'],
  });
export type StatsQuery = z.infer<typeof statsQuery>;

export const statsDay = z.object({
  /** YYYY-MM-DD in the workspace timezone. */
  date: z.string(),
  calls: z.number().int(),
  missed: z.number().int(),
  minutes: z.number(),
  credits: z.number(),
});

export const statsResponse = z.object({
  range: statsRange,
  from: isoDateTime,
  to: isoDateTime,
  timezone: z.string(),
  calls: z.object({
    total: z.number().int(),
    /** Reached the agent (any non-declined row). */
    answered: z.number().int(),
    /** Declined by the §13.9 checks. */
    missed: z.number().int(),
    test: z.number().int(),
  }),
  minutes: z.number(),
  credits_used: z.number(),
  avg_duration_s: z.number().nullable(),
  missed_by_reason: z.record(declineReason, z.number().int()),
  by_day: z.array(statsDay),
});
export type StatsResponse = z.infer<typeof statsResponse>;

/** PATCH /calls/:id {handled, note} — D2 detail actions. */
export const callPatch = z
  .object({
    handled: z.boolean().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .refine((b) => b.handled !== undefined || b.note !== undefined, { message: 'Nothing to update' });
export type CallPatch = z.infer<typeof callPatch>;

/** POST /agents/:id/test/web {version_no} — §13.4 browser test call. Default: the draft. */
export const testWebCallRequest = z.object({
  version_no: z.number().int().min(1).optional(),
});
export type TestWebCallRequest = z.infer<typeof testWebCallRequest>;

/**
 * §16's example (`call_id`, `access_token`, `rate`, `balance`) plus what the browser SDK
 * needs to join: a token minted for one transport is refused by the other (D2 finding),
 * so `transport`, `url` and `ice_servers` travel with it. None of them names the vendor.
 */
export const testWebCallResponse = z.object({
  call_id: z.string(),
  access_token: z.string(),
  /** Credits per minute this call bills at — the tier of the version under test. */
  rate: z.number(),
  /** Wallet balance when the call was minted, 2 dp. */
  balance: z.number(),
  version_no: z.number().int(),
  /** The ceiling this call was given: min(the version's limit, what the balance covers). */
  max_call_duration_s: z.number().int(),
  /**
   * The credential for this call's live transcript: the browser SDK offers it as the
   * bearer subprotocol to `wss://<api>/test-calls/v2/monitor-call/{call_id}`, which our
   * API relays (ADR 0003, D9 addendum). Bound to this call, expires with it.
   */
  live_token: z.string(),
  transport: z.string().optional(),
  url: z.string().optional(),
  ice_servers: z.array(z.record(z.unknown())).optional(),
  expires_at: z.number().optional(),
});
export type TestWebCallResponse = z.infer<typeof testWebCallResponse>;
