import { z } from 'zod';
import { businessHours, businessHoursInput, isTimeZone } from './business-hours.js';
import { e164, isoDateTime, paginationQuery, uuid } from './common.js';
import { memberRole, planTier } from './enums.js';

/*
 * Workspaces, members and invites (§6, §13.2, §16).
 *
 * The product word is "workspace" everywhere on the wire; the table is `tenants` and the
 * translation happens once, in WorkspaceGuard (CLAUDE.md, Glossary). Nothing below ever
 * says tenant.
 */

/** ISO 3166-1 alpha-2, upper case. US and CA at launch (§20 item 4). */
export const countryCode = z
  .string()
  .length(2)
  .regex(/^[A-Za-z]{2}$/, 'Two-letter country code')
  .transform((value) => value.toUpperCase());

/** A4 — Workspace setup (spec p. 12). Country and timezone are required; the rest is not. */
export const createWorkspaceRequest = z.object({
  name: z.string().trim().min(2).max(80),
  country: countryCode,
  /** IANA name. Not validated against the tz database here — the API does that. */
  timezone: z.string().min(1).max(64),
  phone: e164.optional(),
  website: z.string().url().max(300).optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequest>;

/** PATCH /workspace — D6 Settings. Ownership, plan and credits are never editable here. */
export const updateWorkspaceRequest = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  /** D16: the fallback zone of every schedule, so it must be one the hours check can read. */
  timezone: z.string().min(1).max(64).refine(isTimeZone, 'Not a time zone we recognise').optional(),
  website: z.string().url().max(300).nullable().optional(),
  business_hours: businessHoursInput.nullable().optional(),
  recording_default: z.boolean().optional(),
  /** §17 retention, 7–365 days. */
  retention_days: z.number().int().min(7).max(365).optional(),
  /** D6 Data & privacy (QA-081): new agents start with PII removal on. Plan gate `pii_removal`. */
  pii_removal_default: z.boolean().optional(),
  /**
   * D6 Data & privacy (QA-081): an agent that records calls tells the caller so before
   * its greeting. Added at the platform sync, never stored in the script.
   */
  recording_notice: z.boolean().optional(),
  /** The notice in the business's own words; `null` (or blank) goes back to ours, in the agent's language. */
  recording_notice_text: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((value) => (value === '' ? null : value)),
  // No `onboarding_step`: the wizard pointer moves forward only, through
  // POST /workspace/onboarding-step. Sent here it is stripped, never written (QA-058).
});
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequest>;

/**
 * POST /workspace/onboarding-step — the wizard's resume pointer (§6.4), editor and up.
 * Editors build, test and route the agent (W1–W6), so they move the pointer too; the
 * server only ever moves it forward (QA-005). Settings stay on PATCH /workspace.
 */
export const advanceOnboardingRequest = z.object({
  step: z.number().int().min(1).max(7),
});
export type AdvanceOnboardingRequest = z.infer<typeof advanceOnboardingRequest>;

export const workspaceResponse = z.object({
  id: uuid,
  name: z.string(),
  country: z.string(),
  timezone: z.string(),
  website: z.string().nullable(),
  plan_tier: planTier,
  concurrency_cap: z.number().int(),
  kb_allowance: z.number().int(),
  business_hours: businessHours.nullable(),
  recording_default: z.boolean(),
  retention_days: z.number().int(),
  pii_removal_default: z.boolean(),
  recording_notice: z.boolean(),
  recording_notice_text: z.string().nullable(),
  onboarding_step: z.number().int(),
  onboarding_completed_at: isoDateTime.nullable(),
  /** Set by staff (SA12). The D1 banner reads it; the inbound path declines on it. */
  paused: z.boolean(),
  paused_reason: z.string().nullable(),
  /** The caller's own role in this workspace, so the UI can gate without a second call. */
  role: memberRole,
  created_at: isoDateTime,
});
export type WorkspaceResponse = z.infer<typeof workspaceResponse>;

/** GET /workspace/checklist — §6.4 onboarding gating, computed server-side. */
export const workspaceChecklist = z.object({
  workspace_created: z.boolean(),
  agent_created: z.boolean(),
  agent_generated: z.boolean(),
  agent_published: z.boolean(),
  credits_purchased: z.boolean(),
  number_attached: z.boolean(),
  onboarding_step: z.number().int(),
  complete: z.boolean(),
});
export type WorkspaceChecklist = z.infer<typeof workspaceChecklist>;

// ---------------------------------------------------------------------------
// Members and invites (§6.1, A8)
// ---------------------------------------------------------------------------

/** Roles that can be handed out. `owner` is reached only through transfer-ownership. */
export const assignableRole = z.enum(['admin', 'editor', 'viewer']);
export type AssignableRole = z.infer<typeof assignableRole>;

export const memberResponse = z.object({
  /** `memberships.id` — what PATCH/DELETE /members/:id address. */
  id: uuid,
  user_id: uuid,
  email: z.string(),
  name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  role: memberRole,
  joined_at: isoDateTime,
});
export type MemberResponse = z.infer<typeof memberResponse>;

export const inviteRequest = z.object({
  email: z.string().email().max(254).toLowerCase(),
  role: assignableRole,
});
export type InviteRequest = z.infer<typeof inviteRequest>;

/**
 * The token is returned **once**, on creation, because only its hash is stored (A8).
 * Nothing can read it back afterwards, including staff.
 */
/**
 * Where an invite is in its life, derived by the server from `accepted_at` and
 * `expires_at` against its own clock (D11, BUG-010): an expired link was listed as
 * pending, and a browser's clock is not the one the accept route checks.
 */
export const inviteStatus = z.enum(['pending', 'expired', 'accepted']);
export type InviteStatus = z.infer<typeof inviteStatus>;

/** The status an invite row is in at `now`. Accepted wins over expired: it was used in time. */
export function inviteStatusAt(row: { expires_at: string | Date; accepted_at: string | Date | null }, now: Date = new Date()): InviteStatus {
  if (row.accepted_at) return 'accepted';
  // The same comparison the accept route makes: usable up to and including `expires_at`.
  return new Date(row.expires_at).getTime() < now.getTime() ? 'expired' : 'pending';
}

export const inviteResponse = z.object({
  id: uuid,
  email: z.string(),
  role: memberRole,
  invited_by: uuid,
  expires_at: isoDateTime,
  accepted_at: isoDateTime.nullable(),
  created_at: isoDateTime,
  status: inviteStatus,
  token: z.string().optional(),
  /**
   * POST /invites only: what happened to the invitation email. `not_configured` is a box
   * with no email provider (dev): the link is still returned to share by hand.
   */
  email_status: z.enum(['sent', 'failed', 'not_configured']).optional(),
});
export type InviteResponse = z.infer<typeof inviteResponse>;

/**
 * GET /invites/:token/preview — what the A8 join screen shows before the click: which
 * workspace, who asked, which role. Answered only to a verified sign-in *as the invited
 * address*, so a forwarded or leaked link tells anyone else nothing beyond "not for you".
 */
export const invitePreviewResponse = z.object({
  workspace_name: z.string(),
  role: memberRole,
  /** The inviter's name, else their email. */
  invited_by: z.string(),
  expires_at: isoDateTime,
  /** Already in the workspace: accepting just opens it. */
  already_member: z.boolean(),
});
export type InvitePreviewResponse = z.infer<typeof invitePreviewResponse>;

export const acceptInviteResponse = z.object({
  workspace_id: uuid,
  workspace_name: z.string(),
  role: memberRole,
});
export type AcceptInviteResponse = z.infer<typeof acceptInviteResponse>;

export const updateMemberRequest = z.object({ role: assignableRole });
export type UpdateMemberRequest = z.infer<typeof updateMemberRequest>;

/** POST /workspace/transfer-ownership — owner only, target must already be a member. */
export const transferOwnershipRequest = z.object({ user_id: uuid });
export type TransferOwnershipRequest = z.infer<typeof transferOwnershipRequest>;

// ---------------------------------------------------------------------------
// GET /audit-log — D6 Audit log (§6.2, §16)
// ---------------------------------------------------------------------------

/** Narrow by the part before the dot of `action` (`agent`, `number`, `member`, …). */
export const auditLogQuery = paginationQuery.extend({
  area: z.string().regex(/^[a-z_]{2,32}$/).optional(),
});
export type AuditLogQuery = z.infer<typeof auditLogQuery>;

/**
 * One `audit_log` row as an owner or admin reads it. `meta` is what the writing service
 * recorded — ids, field names and booleans such as `has_password`, never a secret.
 * `actor` is null for the system (a schedule, a webhook) or a user who has since left.
 */
export const auditEntryResponse = z.object({
  id: uuid,
  action: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  actor: z.object({ user_id: uuid, email: z.string(), name: z.string().nullable() }).nullable(),
  ip: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()).nullable(),
  created_at: isoDateTime,
});
export type AuditEntryResponse = z.infer<typeof auditEntryResponse>;

// ---------------------------------------------------------------------------
// POST /webhooks/auth (§13.2)
// ---------------------------------------------------------------------------

/**
 * What the Auth0 Post-User-Registration Action posts — the exact shape in
 * `infra/auth0/actions/customer-post-registration.js`, which shipped with D1 and is
 * already installed in the tenant. The schema follows the Action, not the other way
 * round: changing it would mean re-deploying an Action to change a payload nobody asked
 * to change.
 *
 * `external_id` is the Auth0 `sub`, and it is the only field that identifies a person for
 * good — emails change, `sub` does not. The Post-Login Action is the safety net for a
 * registration webhook that never arrived, so `user.login` is accepted here too and does
 * exactly the same upsert.
 */
export const authWebhookEvent = z.object({
  event_type: z.enum(['user.registered', 'user.created', 'user.login']),
  external_id: z.string().min(1).max(200),
  email: z.string().email().max(254),
  email_verified: z.boolean().default(false),
  name: z.string().max(200).nullable().optional(),
  picture: z.string().max(1_000).nullable().optional(),
  created_at: z.string().max(64).optional(),
});
export type AuthWebhookEvent = z.infer<typeof authWebhookEvent>;
