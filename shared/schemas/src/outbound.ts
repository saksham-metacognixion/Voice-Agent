import { z } from 'zod';
import { isTimeZone, timeOfDay } from './business-hours.js';
import { isoDateTime, paginationQuery, uuid } from './common.js';
import { planTier } from './enums.js';

/**
 * P2 (D18) outbound click-to-call and the compliance gates TCPA / the CRTC rules require
 * (ADR 0031). Outbound is a **callback**: the D2 call detail rings the other party of a call
 * the workspace already has, never a number typed in. Every check runs on the server, in
 * one order, before the platform is asked (`modules/outbound`).
 */

// ------------------------------------------------------------------ platform policy (pricing config)

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/** One day's calling window in the destination's local time, `start` inclusive, `end` exclusive. */
export const callingWindow = z
  .object({ start: timeOfDay, end: timeOfDay })
  .refine((w) => w.start < w.end, { message: 'The window must end after it starts.', path: ['end'] });
export type CallingWindow = z.infer<typeof callingWindow>;

/**
 * The calling rules for one destination country. A number does not say which of its
 * country's time zones it rings in (a mobile number keeps its area code when its owner
 * moves), so a call is allowed only when it is inside the window in **every** zone listed —
 * the conservative reading of "the called party's local time".
 */
export const outboundCountryRule = z.object({
  zones: z.array(z.string().refine(isTimeZone, 'Not a time zone we recognise')).min(1).max(12),
  /** The local window per weekday; null = no calls that day. */
  days: z.object({
    mon: callingWindow.nullable(),
    tue: callingWindow.nullable(),
    wed: callingWindow.nullable(),
    thu: callingWindow.nullable(),
    fri: callingWindow.nullable(),
    sat: callingWindow.nullable(),
    sun: callingWindow.nullable(),
  }),
  /** Local dates with no calls at all (public holidays where a rule forbids them). */
  closed_dates: z.array(isoDate).max(100).default([]),
});
export type OutboundCountryRule = z.infer<typeof outboundCountryRule>;

const everyDay = (start: string, end: string) => ({ start, end });

/**
 * The defaults: the two launch markets, as the regulations read (ADR 0031 §4).
 *   US — 47 CFR 64.1200(c)(1): 8 am to 9 pm at the called party's location, every day.
 *   CA — CRTC Unsolicited Telecommunications Rules, Part III: weekdays 9 am to 9:30 pm,
 *        weekends 10 am to 6 pm, the called party's local time.
 * A country without a rule cannot be called; staff add one with a pricing publish.
 */
export const DEFAULT_OUTBOUND_COUNTRIES: Record<string, OutboundCountryRule> = {
  US: {
    zones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu'],
    days: {
      mon: everyDay('08:00', '21:00'),
      tue: everyDay('08:00', '21:00'),
      wed: everyDay('08:00', '21:00'),
      thu: everyDay('08:00', '21:00'),
      fri: everyDay('08:00', '21:00'),
      sat: everyDay('08:00', '21:00'),
      sun: everyDay('08:00', '21:00'),
    },
    closed_dates: [],
  },
  CA: {
    zones: ['America/St_Johns', 'America/Halifax', 'America/Toronto', 'America/Winnipeg', 'America/Regina', 'America/Edmonton', 'America/Vancouver', 'America/Whitehorse'],
    days: {
      mon: everyDay('09:00', '21:30'),
      tue: everyDay('09:00', '21:30'),
      wed: everyDay('09:00', '21:30'),
      thu: everyDay('09:00', '21:30'),
      fri: everyDay('09:00', '21:30'),
      sat: everyDay('10:00', '18:00'),
      sun: everyDay('10:00', '18:00'),
    },
    closed_dates: [],
  },
};

/** Outbound calls a workspace may place per local day, by plan tier. The trial places none. */
export const DEFAULT_OUTBOUND_DAILY_CAPS = { trial: 0, starter: 20, growth: 50, scale: 150, pro: 400, volume: 1000 } as const;

/**
 * `pricing_configs.config_json.outbound` — admin-published, versioned, defaulted so every
 * stored config parses. Read through `PlatformConfigService.outboundPolicy()` only.
 */
export const outboundPolicy = z.object({
  daily_caps: z
    .object(Object.fromEntries(planTier.options.map((t) => [t, z.number().int().min(0)])) as Record<z.infer<typeof planTier>, z.ZodNumber>)
    .default(DEFAULT_OUTBOUND_DAILY_CAPS),
  /**
   * A callback goes only to someone who called the workspace within this many days — the
   * inquiry an established business relationship rests on (TSR / TCPA: 3 months; CRTC:
   * 6 months; the stricter is the default). See ADR 0031 §3 before raising it.
   */
  prior_contact_days: z.number().int().min(1).max(180).default(90),
  countries: z.record(z.string().length(2).toUpperCase(), outboundCountryRule).default(DEFAULT_OUTBOUND_COUNTRIES),
});
export type OutboundPolicy = z.infer<typeof outboundPolicy>;

// ------------------------------------------------------------------ business verification (KYC)

export const kycStatus = z.enum(['none', 'pending', 'verified', 'rejected']);
export type KycStatus = z.infer<typeof kycStatus>;

/** What the customer submits for review. Stored as `tenants.kyc_json`; reviewed by staff. */
export const kycDetails = z.object({
  legal_name: z.string().trim().min(2).max(200),
  registration_number: z.string().trim().min(2).max(60),
  registration_country: z.string().trim().length(2).toUpperCase(),
  address: z.string().trim().min(5).max(300),
  contact_name: z.string().trim().min(2).max(120),
  /** Optional: a national do-not-call registry subscription (US SAN, CRTC DNCL registration). */
  dnc_registration: z.string().trim().min(1).max(60).nullable().default(null),
});
export type KycDetails = z.infer<typeof kycDetails>;

export const kycResponse = z.object({
  status: kycStatus,
  submitted_at: isoDateTime.nullable(),
  decided_at: isoDateTime.nullable(),
  /** The sentence staff wrote with a rejection, for the customer. */
  reason: z.string().nullable(),
  details: kycDetails.nullable(),
});
export type KycResponse = z.infer<typeof kycResponse>;

// ------------------------------------------------------------------ the workspace's outbound settings

/**
 * What the agent does when an outbound call reaches a voicemail box (§9 platform option
 * `voicemail_option`, per call). `hang_up` is the default: a machine is not the person who
 * asked to be called back, and every second of it is billed.
 */
export const voicemailDetection = z.enum(['off', 'hang_up', 'leave_message']);
export type VoicemailDetection = z.infer<typeof voicemailDetection>;

export const VOICEMAIL_MESSAGE_MAX = 300;

export const outboundSettings = z
  .object({
    voicemail_detection: voicemailDetection.default('hang_up'),
    voicemail_message: z.string().trim().min(1).max(VOICEMAIL_MESSAGE_MAX).nullable().default(null),
  })
  .refine((s) => s.voicemail_detection !== 'leave_message' || Boolean(s.voicemail_message), {
    message: 'Write the message the agent leaves.',
    path: ['voicemail_message'],
  });
export type OutboundSettings = z.infer<typeof outboundSettings>;

export const DEFAULT_OUTBOUND_SETTINGS: OutboundSettings = { voicemail_detection: 'hang_up', voicemail_message: null };

export const callerIdVia = z.enum(['purchase', 'staff']);

/** One of the workspace's numbers, as a caller ID. */
export const callerIdResponse = z.object({
  number_id: uuid,
  e164: z.string(),
  nickname: z.string().nullable(),
  /** `bought` from us, or a `sip` import. Never the carrier: provider names stay server-side. */
  kind: z.enum(['bought', 'sip']),
  status: z.string(),
  verified: z.boolean(),
  verified_via: callerIdVia.nullable(),
});
export type CallerIdResponse = z.infer<typeof callerIdResponse>;

/** GET /outbound — the D6 "Outbound calling" tab. */
export const outboundOverview = z.object({
  /** The `outbound_calls` feature flag for this workspace. Off = the D2 action is not offered. */
  enabled: z.boolean(),
  kyc: kycResponse,
  settings: outboundSettings,
  caller_ids: z.array(callerIdResponse),
  daily_cap: z.number().int(),
  used_today: z.number().int(),
  prior_contact_days: z.number().int(),
  /** Countries with calling rules, i.e. the ones that can be called. */
  countries: z.array(z.string()),
});
export type OutboundOverview = z.infer<typeof outboundOverview>;

// ------------------------------------------------------------------ click-to-call from D2

/**
 * Why a callback cannot be placed — exactly the error code `POST /calls/:id/callback`
 * would answer, in the order the server checks them.
 */
export const outboundRefusal = z.enum([
  'OUTBOUND_DISABLED',
  'WORKSPACE_PAUSED',
  'KYC_REQUIRED',
  'KYC_PENDING',
  'KYC_REJECTED',
  'OUTBOUND_NOT_CONFIGURED',
  'CALLER_ID_REQUIRED',
  'CALLER_ID_UNVERIFIED',
  'AGENT_NOT_PUBLISHED',
  'DESTINATION_INVALID',
  'DESTINATION_COUNTRY',
  'DESTINATION_IS_AGENT',
  'DNC_LISTED',
  'NO_PRIOR_CONTACT',
  'OUTSIDE_CALLING_WINDOW',
  'PURCHASE_REQUIRED',
  'NO_CREDITS',
  'OUTBOUND_DAILY_CAP',
]);
export type OutboundRefusal = z.infer<typeof outboundRefusal>;

/**
 * POST /calls/:id/callback. `idempotency_key` is one per press (the portal makes it when the
 * panel opens and after each answer): a double click, a retry or a second tab with the same
 * key is one call. `number_id` picks the caller ID; default — the number the call came in
 * on, else one answering for the agent, else any verified one.
 */
export const callbackRequest = z.object({
  idempotency_key: uuid,
  number_id: uuid.optional(),
});
export type CallbackRequest = z.infer<typeof callbackRequest>;

/** GET /calls/:id/callback — the same checks as the POST, run without placing anything. */
export const callbackCheck = z.object({
  allowed: z.boolean(),
  reason: outboundRefusal.nullable(),
  /** For `OUTSIDE_CALLING_WINDOW`: the next instant every zone of the destination allows a call. */
  next_allowed_at: isoDateTime.nullable(),
  to_number: z.string().nullable(),
  from_number: z.string().nullable(),
  number_id: uuid.nullable(),
  agent_id: uuid.nullable(),
  voicemail_detection: voicemailDetection,
  daily_cap: z.number().int(),
  used_today: z.number().int(),
  prior_contact_days: z.number().int(),
});
export type CallbackCheck = z.infer<typeof callbackCheck>;

export const callbackResponse = z.object({
  /** The new outbound call; D2 shows it at `?call=` from the first frame. */
  call_id: z.string(),
  from_number: z.string(),
  to_number: z.string(),
  agent_id: uuid,
  voicemail_detection: voicemailDetection,
  rate: z.number(),
  balance: z.number(),
  /** The call's ceiling. 0 on a replayed `idempotency_key`: the call was placed by the first request. */
  max_call_duration_s: z.number().int(),
  daily_cap: z.number().int(),
  used_today: z.number().int(),
});
export type CallbackResponse = z.infer<typeof callbackResponse>;

// ------------------------------------------------------------------ the workspace's do-not-call list

export const dncSource = z.enum(['call', 'manual']);

export const dncEntryResponse = z.object({
  id: uuid,
  e164: z.string(),
  source: dncSource,
  reason: z.string().nullable(),
  created_by_name: z.string().nullable(),
  created_at: isoDateTime,
});
export type DncEntryResponse = z.infer<typeof dncEntryResponse>;

/**
 * POST /dnc — add a number (typed, read like "Call my phone" reads one) or the other party
 * of a D2 call. Exactly one of the two. Adding a number already listed answers the entry.
 */
export const dncAddRequest = z
  .object({
    number: z.string().trim().min(3).max(40).optional(),
    call_id: z.string().min(1).max(120).optional(),
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .refine((b) => (b.number === undefined) !== (b.call_id === undefined), {
    message: 'Give a number or a call, not both.',
    path: ['number'],
  });
export type DncAddRequest = z.infer<typeof dncAddRequest>;

export const dncQuery = paginationQuery;
