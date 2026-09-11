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

/** Spec §16 — SSE topics. */
export const sseTopic = z.union([
  z.literal('wallet'),
  z.string().regex(/^agent:[0-9a-f-]+$/),
  z.string().regex(/^call:[0-9a-f-]+$/),
  z.string().regex(/^activation:[0-9a-f-]+$/),
]);
