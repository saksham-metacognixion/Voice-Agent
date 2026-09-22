import { z } from 'zod';

/** Spec §6.1 — customer roles. Exactly one owner per workspace. */
export const memberRole = z.enum(['owner', 'admin', 'editor', 'viewer']);
export type MemberRole = z.infer<typeof memberRole>;

/** Admin spec §2.2 — staff roles. */
export const staffRole = z.enum(['super_admin', 'ops', 'finance', 'support', 'read_only']);
export type StaffRole = z.infer<typeof staffRole>;

/** Spec §5.2 — plan tier is set by the largest pack bought in the last 12 months. */
export const planTier = z.enum(['trial', 'starter', 'growth', 'scale', 'pro', 'volume']);
export type PlanTier = z.infer<typeof planTier>;

/** Spec §4.3 — agent tier drives the model/voice stack and the credit rate. */
export const agentTier = z.enum(['standard', 'premium']);
export type AgentTier = z.infer<typeof agentTier>;

export const agentStatus = z.enum(['draft', 'live', 'paused']);
export type AgentStatus = z.infer<typeof agentStatus>;

/** Spec §9.9 */
export const versionSource = z.enum(['generated', 'feedback', 'manual', 'regenerate']);
export type VersionSource = z.infer<typeof versionSource>;

/** Spec §13.9 — why an inbound call was declined. */
export const declineReason = z.enum(['balance', 'cap', 'blocked', 'hours', 'paused']);
export type DeclineReason = z.infer<typeof declineReason>;

/** Spec §9.2 — template catalogue ids. */
export const templateId = z.enum([
  'receptionist',
  'appointment',
  'afterhours',
  'lead_qual',
  'faq_support',
  'restaurant',
  'custom',
]);
export type TemplateId = z.infer<typeof templateId>;

/**
 * Spec §16 — SSE topics: `wallet`, `alerts`, `agent:{id}`, `call:{id}`, `activation:{id}`.
 *
 * `call:{id}` is deliberately wider than a uuid: `calls.id` is the Retell `call_id`
 * (`call_016c7be0a88e114a05437321e03`) for a real call and `dec_<uuid>` for a §13.9
 * decline, so a hex-only pattern would reject every real call topic.
 */
export const sseTopic = z.union([
  z.literal('wallet'),
  /** D7: low-balance, rental and concurrency alerts for the D1 banner (`GET /alerts/active`). */
  z.literal('alerts'),
  z.string().regex(/^agent:[0-9a-f-]+$/),
  z.string().regex(/^call:[A-Za-z0-9_-]+$/),
  z.string().regex(/^activation:[0-9a-f-]+$/),
]);

/**
 * Role precedence for the §6.1 matrix. Higher wins. Used for "admin or above" checks;
 * capabilities that are not a simple ladder (only an Owner transfers ownership; an admin
 * may not change the Owner's role) are enforced explicitly in the service.
 */
export const ROLE_RANK: Record<MemberRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

export function roleAtLeast(role: MemberRole, minimum: MemberRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** Admin Appendix B — mandatory on every customer-affecting staff write. */
export const reasonCode = z.enum([
  'goodwill',
  'service_issue',
  'billing_error',
  'promo',
  'partner_deal',
  'fraud_suspected',
  'abuse_policy',
  'customer_request',
  'chargeback',
  'expiry_extension',
  'testing_internal',
  'support_investigation',
  'legal_request',
  'other',
]);
export type ReasonCode = z.infer<typeof reasonCode>;

/** Admin Appendix B: `other` is only accepted with a note. */
export const reasonCodeWithNote = z
  .object({ reason_code: reasonCode, note: z.string().min(1).optional() })
  .refine((v) => v.reason_code !== 'other' || Boolean(v.note?.trim()), {
    message: 'A note is required when the reason code is "other"',
    path: ['note'],
  });

/** §16 auth headers. X-Workspace-Id is required on every workspace-scoped route. */
export const WORKSPACE_HEADER = 'x-workspace-id';

/** Namespaced Auth0 claims added by the Post-Login Action (ADR 0002). */
export const CLAIM_EMAIL_VERIFIED = 'https://portal/email_verified';
export const CLAIM_MFA = 'https://portal/mfa';
/**
 * The signed-in person's email and display name, stamped on the customer access token
 * by the Post-Login Action. Auth0 access tokens carry neither by default, and the API
 * needs both to provision a `users` row for a sign-in whose registration webhook never
 * arrived (§13.2). Only these namespaced claims are trusted for that; a bare `email`
 * claim is not, because our Action is the only thing that writes under this namespace.
 */
export const CLAIM_EMAIL = 'https://portal/email';
export const CLAIM_NAME = 'https://portal/name';
