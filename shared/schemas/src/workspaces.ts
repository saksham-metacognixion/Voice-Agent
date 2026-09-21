import { z } from 'zod';
import { businessHours } from './business-hours.js';
import { e164, isoDateTime, uuid } from './common.js';
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
  timezone: z.string().min(1).max(64).optional(),
  website: z.string().url().max(300).nullable().optional(),
  business_hours: businessHours.nullable().optional(),
  recording_default: z.boolean().optional(),
  /** §17 retention, 7–365 days. */
  retention_days: z.number().int().min(7).max(365).optional(),
  /** Resume from a paused state is a staff action (SA12), never this route. */
  onboarding_step: z.number().int().min(1).max(7).optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequest>;

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
export const inviteResponse = z.object({
  id: uuid,
  email: z.string(),
  role: memberRole,
  invited_by: uuid,
  expires_at: isoDateTime,
  accepted_at: isoDateTime.nullable(),
  created_at: isoDateTime,
  token: z.string().optional(),
});
export type InviteResponse = z.infer<typeof inviteResponse>;

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
