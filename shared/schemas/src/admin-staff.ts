import { z } from 'zod';
import { healthSignal, staffLimits } from './admin.js';
import { activationStatus, activationStep } from './activation.js';
import { jobStatus } from './agents.js';
import { isoDateTime, paginationQuery, uuid } from './common.js';
import { planTier, staffRole } from './enums.js';
import { phoneNumberStatus } from './numbers.js';

/*
 * D13 — SA13 "Staff & settings" (admin §4 SA13, §2.1, §2.2, §10) and the SA7
 * provisioning-queue and concurrency views (admin §4 SA7). Staff routes only, under
 * `/admin/*`. Nothing here is a Prisma row: `bound` is derived from the placeholder
 * `auth_provider_id` an invite carries, and the concurrency answer says when it could
 * not read Redis rather than reporting zero.
 */

// ---------------------------------------------------------------------------- staff members (SA13)

/** One `staff_users` row as the console lists it. `bound = false` is an invite nobody has signed in on yet. */
export const staffMemberResponse = z.object({
  id: uuid,
  email: z.string(),
  name: z.string().nullable(),
  role: staffRole,
  /** Informational until per-person exemption exists: the API requires the MFA claim of everyone (admin §2.1). */
  mfa_enforced: z.boolean(),
  active: z.boolean(),
  last_login_at: isoDateTime.nullable(),
  created_at: isoDateTime,
  /** True once the identity provider's `sub` is known; false while the row is still an invite. */
  bound: z.boolean(),
});
export type StaffMemberResponse = z.infer<typeof staffMemberResponse>;

/** POST /admin/staff — invite a colleague. The domain is checked server-side against `STAFF_ALLOWED_EMAIL_DOMAIN`. */
export const adminInviteStaffRequest = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(120).optional(),
  role: staffRole,
});
export type AdminInviteStaffRequest = z.infer<typeof adminInviteStaffRequest>;

/** PATCH /admin/staff/:id — role, activation, name, MFA flag. At least one field. */
export const adminUpdateStaffRequest = z
  .object({
    role: staffRole.optional(),
    active: z.boolean().optional(),
    name: z.string().trim().min(1).max(120).nullable().optional(),
    mfa_enforced: z.boolean().optional(),
    /** Kept in the audit row. */
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .refine(
    (v) =>
      v.role !== undefined ||
      v.active !== undefined ||
      v.name !== undefined ||
      v.mfa_enforced !== undefined,
    {
      message: 'Nothing to change.',
      path: ['role'],
    },
  );
export type AdminUpdateStaffRequest = z.infer<typeof adminUpdateStaffRequest>;

// ---------------------------------------------------------------------------- role limits (admin §2.2)

/** The limits as written: the three caps are non-negative or null (no ceiling). */
export const staffLimitsInput = staffLimits.extend({
  credit_adjust_max_per_action: z.number().min(0).max(1_000_000).nullable(),
  credit_adjust_max_per_day: z.number().min(0).max(10_000_000).nullable(),
  refund_max_cents: z.number().int().min(0).max(100_000_000).nullable(),
});

/** The whole admin §2.2 matrix, one object per role. */
export const staffLimitsMatrix = z.object({
  super_admin: staffLimitsInput,
  ops: staffLimitsInput,
  finance: staffLimitsInput,
  support: staffLimitsInput,
  read_only: staffLimitsInput,
});
export type StaffLimitsMatrix = z.infer<typeof staffLimitsMatrix>;

/** GET /admin/staff/limits. */
export const adminStaffLimitsResponse = z.object({
  limits: staffLimitsMatrix,
  /** The newest `updated_at` across the five rows, or null when none is seeded. */
  updated_at: isoDateTime.nullable(),
});
export type AdminStaffLimitsResponse = z.infer<typeof adminStaffLimitsResponse>;

/** PUT /admin/staff/limits — replaces all five rows in one transaction. */
export const adminStaffLimitsRequest = z.object({
  limits: staffLimitsMatrix,
  note: z.string().trim().min(1).max(1000).optional(),
});
export type AdminStaffLimitsRequest = z.infer<typeof adminStaffLimitsRequest>;

// ---------------------------------------------------------------------------- provisioning queue (SA7)

export const adminProvisioningQuery = paginationQuery.extend({
  status: jobStatus.optional(),
  tenant_id: uuid.optional(),
});
export type AdminProvisioningQuery = z.infer<typeof adminProvisioningQuery>;

/** The activation step machine as the customer would see it (`activationView`, minus the per-step list). */
export const adminProvisioningActivation = z.object({
  status: activationStatus,
  step: activationStep.nullable(),
  progress: z.number().int().min(0).max(100),
  attempt: z.number().int().min(0),
  max_attempts: z.number().int().min(1),
  /** Customer-safe, only when failed. Never the provider's detail. */
  error: z.string().nullable(),
});

/** One `jobs` row of type `activate-agent`, `provision-number` or `knowledge-sync`. */
export const adminProvisioningJob = z.object({
  id: uuid,
  type: z.string(),
  status: jobStatus,
  tenant: z.object({ id: uuid, name: z.string() }).nullable(),
  agent: z.object({ id: uuid, name: z.string() }).nullable(),
  number: z.object({ id: uuid, e164: z.string().nullable(), status: phoneNumberStatus }).nullable(),
  activation: adminProvisioningActivation.nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
  /** Failed, with its payload kept, so `POST /admin/jobs/:id/retry` can re-enqueue it. */
  retryable: z.boolean(),
});
export type AdminProvisioningJob = z.infer<typeof adminProvisioningJob>;

// ---------------------------------------------------------------------------- concurrency (SA7)

export const adminConcurrencyTenant = z.object({
  tenant_id: uuid,
  tenant_name: z.string(),
  live: z.number().int().min(0),
  /** The plan's concurrency cap, from the same `caps:{ws}` the inbound checks read; null when it could not be resolved. */
  cap: z.number().int().nullable(),
  plan_tier: planTier.nullable(),
  /** `live / cap`, rounded to a whole percent; null without a cap. */
  pct_of_cap: z.number().int().nullable(),
});

/** GET /admin/concurrency — live calls from the `active:{ws}` hashes, per workspace and in total. */
export const adminConcurrencyResponse = z.object({
  /** `CONCURRENCY_PLATFORM_LIMIT`, or null when the operator has not set one. */
  allowance: z.number().int().nullable(),
  /** Live calls platform-wide; null when Redis did not answer or the scan stopped early — never zero for an outage. */
  live: z.number().int().nullable(),
  signal: healthSignal,
  /** True only when every `active:*` key was walked. */
  complete: z.boolean(),
  /** `CONCURRENCY_ALERT_PCT`: the threshold the §14.3 monitor alerts at. */
  alert_threshold_pct: z.number().int(),
  checked_at: isoDateTime,
  tenants: z.array(adminConcurrencyTenant),
});
export type AdminConcurrencyResponse = z.infer<typeof adminConcurrencyResponse>;
