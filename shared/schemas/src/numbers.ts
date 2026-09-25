import { z } from 'zod';
import { businessHours } from './business-hours.js';
import { e164, isoDateTime, uuid } from './common.js';
import { countryCode } from './workspaces.js';

/*
 * Phone numbers (W6, D4, §11, §13.8, §15 `phone_plans` / `phone_numbers`).
 *
 * Option A buys a number, B buys one and the customer forwards their existing line to
 * it, C imports the customer's SIP trunk, D (porting) is P3. The plan is captured on W6;
 * the activation job (§13.8) executes it after payment.
 */

export const phonePlanOption = z.enum(['new', 'forward', 'sip', 'port']);
export type PhonePlanOption = z.infer<typeof phonePlanOption>;

export const phonePlanStatus = z.enum(['pending', 'executed']);
export type PhonePlanStatus = z.infer<typeof phonePlanStatus>;

export const phoneNumberStatus = z.enum(['provisioning', 'active', 'paused', 'releasing', 'released', 'failed']);
export type PhoneNumberStatus = z.infer<typeof phoneNumberStatus>;

/** Option B: `waiting_for_customer` until they confirm the carrier forwarding is on. */
export const forwardingStatus = z.enum(['waiting_for_customer', 'ready', 'failed']);
export type ForwardingStatus = z.infer<typeof forwardingStatus>;

export const hoursMode = z.enum(['always', 'business', 'custom']);
export type HoursMode = z.infer<typeof hoursMode>;

/** ADR 0003 §4: the platform sells US and CA numbers only. */
export const purchasableCountry = z.enum(['US', 'CA']);
export type PurchasableCountry = z.infer<typeof purchasableCountry>;

export const areaCode = z.string().regex(/^[2-9]\d{2}$/, 'Three-digit area code');

/** Spec p. 26: the carriers W6 has a forwarding guide for. */
export const carrier = z.enum(['bell', 'rogers', 'telus', 'videotron', 'att', 'verizon', 'tmobile', 'other']);
export type Carrier = z.infer<typeof carrier>;

/** One transfer target (§11 hand-off). */
export const transferTarget = z.object({
  label: z.string().trim().min(1).max(60),
  number: e164,
});
export type TransferTarget = z.infer<typeof transferTarget>;

const sipHost = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .regex(/^(sip:)?[A-Za-z0-9.-]+(:\d{2,5})?$/, 'A SIP host such as sip.example.com or sip:pbx.example.com:5060');

/**
 * Option C credentials, as sent by the customer. The password is envelope-encrypted
 * the moment it arrives and is never stored, logged or returned in clear (§17).
 */
export const sipCredentials = z.object({
  /** The number the trunk delivers, in E.164. */
  number: e164,
  /** Termination URI / SIP host the platform registers against. */
  host: sipHost,
  username: z.string().trim().min(1).max(128).optional(),
  password: z.string().min(1).max(256).optional(),
});
export type SipCredentials = z.infer<typeof sipCredentials>;

const routing = {
  hours_mode: hoursMode.default('always'),
  hours_override: businessHours.nullable().optional(),
  transfer_targets: z.array(transferTarget).max(5).default([]),
  /** ISO countries allowed to call in. Empty = the platform default. */
  allowed_countries: z.array(countryCode).max(20).default([]),
};

/** PUT /agents/:id/phone-plan (§16). One pending plan per agent; a PUT replaces it. */
export const phonePlanRequest = z.discriminatedUnion('option', [
  z.object({
    option: z.literal('new'),
    country: purchasableCountry,
    area_code: areaCode.optional(),
    toll_free: z.boolean().default(false),
    nickname: z.string().trim().min(1).max(60).optional(),
    ...routing,
  }),
  z.object({
    option: z.literal('forward'),
    country: purchasableCountry,
    area_code: areaCode.optional(),
    /** The line the customer already has and will forward to the new number. */
    existing_number: e164,
    carrier: carrier.default('other'),
    nickname: z.string().trim().min(1).max(60).optional(),
    ...routing,
  }),
  z.object({
    option: z.literal('sip'),
    sip: sipCredentials,
    nickname: z.string().trim().min(1).max(60).optional(),
    ...routing,
  }),
  z.object({ option: z.literal('port'), ...routing }),
]);
export type PhonePlanRequest = z.infer<typeof phonePlanRequest>;

/** The stored plan, with every secret removed. */
export const phonePlanResponse = z.object({
  id: uuid,
  agent_id: uuid,
  option: phonePlanOption,
  country: z.string().nullable(),
  area_code: z.string().nullable(),
  toll_free: z.boolean(),
  existing_number: z.string().nullable(),
  carrier: carrier.nullable(),
  /** Option C: host and username only. The password is never returned. */
  sip: z.object({ number: z.string(), host: z.string(), username: z.string().nullable(), has_password: z.boolean() }).nullable(),
  hours_mode: hoursMode,
  transfer_targets: z.array(transferTarget),
  allowed_countries: z.array(z.string()),
  status: phonePlanStatus,
  /** The number this plan produced, once executed. */
  number_id: uuid.nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
export type PhonePlanResponse = z.infer<typeof phonePlanResponse>;

/** POST /numbers/buy — Option A or B outside the wizard (D4 "Add number"). */
export const buyNumberRequest = z.object({
  agent_id: uuid,
  country: purchasableCountry,
  area_code: areaCode.optional(),
  toll_free: z.boolean().default(false),
  nickname: z.string().trim().min(1).max(60).optional(),
  /** Option B: the line that will be forwarded to this number. */
  forward_from: e164.optional(),
  carrier: carrier.optional(),
  ...routing,
});
export type BuyNumberRequest = z.infer<typeof buyNumberRequest>;

/** POST /numbers/import — Option C outside the wizard. */
export const importNumberRequest = z.object({
  agent_id: uuid,
  sip: sipCredentials,
  nickname: z.string().trim().min(1).max(60).optional(),
  ...routing,
});
export type ImportNumberRequest = z.infer<typeof importNumberRequest>;

/**
 * PATCH /numbers/:id. Routing and labels only. Provider identity (`e164`, type, the
 * platform binding) is not editable here; re-pointing at another agent is.
 */
export const updateNumberRequest = z
  .object({
    nickname: z.string().trim().min(1).max(60).nullable().optional(),
    agent_id: uuid.optional(),
    hours_mode: hoursMode.optional(),
    hours_override: businessHours.nullable().optional(),
    transfer_targets: z.array(transferTarget).max(5).optional(),
    allowed_countries: z.array(countryCode).max(20).optional(),
    blocklist: z.array(e164).max(200).optional(),
    paused: z.boolean().optional(),
    /** Option B: the customer confirms the carrier forwarding is switched on. */
    forwarding_confirmed: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
export type UpdateNumberRequest = z.infer<typeof updateNumberRequest>;

export const phoneNumberResponse = z.object({
  id: uuid,
  agent_id: uuid.nullable(),
  /** null while provisioning has not returned the number yet. */
  e164: z.string().nullable(),
  nickname: z.string().nullable(),
  /** `bought` (A/B) or `sip` (C). The telephony vendor behind `bought` is never named. */
  kind: z.enum(['bought', 'sip']),
  country: z.string().nullable(),
  area_code: z.string().nullable(),
  toll_free: z.boolean(),
  status: phoneNumberStatus,
  paused: z.boolean(),
  hours_mode: hoursMode,
  hours_override: businessHours.nullable(),
  transfer_targets: z.array(transferTarget),
  allowed_countries: z.array(z.string()),
  blocklist: z.array(z.string()),
  forwarding: z
    .object({ from: z.string(), status: forwardingStatus, carrier: carrier.nullable() })
    .nullable(),
  /** Option C: the trunk's host and username. The password is never returned, only whether one is stored. */
  sip: z.object({ host: z.string(), username: z.string().nullable(), has_password: z.boolean() }).nullable(),
  /** Calls that reached this number in the last seven days (D4 list). */
  calls_7d: z.number().int(),
  rental_credits: z.number().int(),
  next_rental_at: isoDateTime.nullable(),
  /** Customer-safe reason when `status = failed`. */
  error: z.string().nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
export type PhoneNumberResponse = z.infer<typeof phoneNumberResponse>;

/** POST /numbers/buy and /import answer 202: the row exists, provisioning is queued. */
export const numberAccepted = z.object({ number: phoneNumberResponse, job_id: uuid });
export type NumberAccepted = z.infer<typeof numberAccepted>;

export const forwardingGuideQuery = z.object({ carrier: carrier.default('other') });

/** GET /numbers/forwarding-guide?carrier= (W6 Option B, D4). */
export const forwardingGuide = z.object({
  carrier,
  /** Dial-code steps, e.g. `*72` + destination. */
  steps: z.array(z.string()),
  disable_steps: z.array(z.string()),
  notes: z.array(z.string()),
});
export type ForwardingGuide = z.infer<typeof forwardingGuide>;
