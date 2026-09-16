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

/** GET /calls (filters) — §16. Everything optional; unknown values are a 422, never a 500. */
export const callsQuery = paginationQuery.extend({
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
});
export type CallsQuery = z.infer<typeof callsQuery>;

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
  created_at: isoDateTime,
});
export type CallSummary = z.infer<typeof callSummary>;

/** GET /calls/:id — the D2 detail adds transcript and analysis. */
export const callDetail = callSummary.extend({
  transcript_text: z.string().nullable(),
  transcript_json: z.unknown().nullable(),
  analysis_json: z.unknown().nullable(),
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
