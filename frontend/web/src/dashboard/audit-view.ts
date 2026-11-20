import { memberRole, planTier, reasonCode } from '@portal/schemas';

/**
 * `audit_log.action` is `<area>.<verb>` written by whichever service did the thing
 * (`agent.published`, `number.release_requested`, `member.role_changed`…). The list is
 * open-ended — a new service can add an action without a portal release — so the D6
 * table names the ones it knows and falls back to a readable form of the rest instead
 * of showing nothing.
 */

/** The D6 area filter, in the order it lists them (`GET /audit-log?area=`). */
export const AUDIT_AREAS = ['agent', 'number', 'knowledge', 'member', 'invite', 'workspace', 'phone_plan', 'billing', 'auto_topup', 'credits', 'purchase', 'user', 'support'] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number];

/** Actions the message file names, as `dashboard.settings.audit.actions.<area>_<verb>`. */
export const KNOWN_AUDIT_ACTIONS = new Set([
  'agent.created',
  'agent.deleted',
  'agent.draft_selected',
  'agent.paused',
  'agent.prompt_edited',
  'agent.published',
  'agent.resumed',
  'agent.activated',
  'number.buy_requested',
  'number.import_requested',
  'number.updated',
  'number.release_requested',
  'number.released_unpaid',
  'knowledge.added',
  'knowledge.removed',
  'knowledge.removal_requested',
  'member.role_changed',
  'member.removed',
  'invite.created',
  'invite.revoked',
  'invite.accepted',
  'workspace.created',
  'workspace.updated',
  'workspace.ownership_transferred',
  'phone_plan.created',
  'phone_plan.updated',
  'billing.portal_session',
  'auto_topup.enabled',
  'auto_topup.disabled',
  // Written by the support team from the admin console (`meta.by = 'staff'`, ADR 0021).
  'workspace.paused',
  'workspace.resumed',
  'number.paused',
  'number.resumed',
  'credits.adjusted',
  'purchase.refunded',
  'user.email_verified',
  'user.mfa_reset',
  'user.locked',
  'user.unlocked',
  'user.force_logout',
  'support.ticket_opened',
]);

export function auditActionKey(action: string): string | null {
  return KNOWN_AUDIT_ACTIONS.has(action) ? action.replace('.', '_') : null;
}

/** `number.release_requested` → "Number · release requested". */
export function humaniseAction(action: string): string {
  const [area, ...rest] = action.split('.');
  const verb = rest.join('.').replace(/[._]/g, ' ').trim();
  const head = (area ?? action).replace(/_/g, ' ');
  const title = head.charAt(0).toUpperCase() + head.slice(1);
  return verb ? `${title} · ${verb}` : title;
}

/**
 * Metadata keys the message file labels, as `dashboard.settings.audit.meta.<key>`. A key
 * outside this list is not shown: the writers also record provider ids, config versions
 * and cleanup details that are neither customer copy nor translatable — and a raw
 * `retell_cleanup_errors` in the Details column would name the platform.
 */
export const KNOWN_AUDIT_META = new Set([
  'agent_id',
  'version_no',
  'name',
  'role',
  'email',
  'user_id',
  'number_id',
  'e164',
  'has_password',
  'has_sip_password',
  'host',
  'from_user_id',
  'to_user_id',
  'paused',
  'toll_free',
  'country',
  'area_code',
  'forward_from',
  'template_id',
  'industry',
  'type',
  'size_bytes',
  'status',
  'status_before',
  'was',
  'fields',
  'option',
  'days_overdue',
  'overdue_since',
  'timezone',
  'trial_credits',
  'lint_warnings',
  'existing_agents',
  // A role change (`member.role_changed`).
  'from',
  'to',
  // Auto top-up settings.
  'pack_id',
  'threshold',
  'card_last4',
  // Staff writes: the Appendix B reason, the credits moved and the line for the customer.
  'reason_code',
  'delta',
  'credits_reversed',
  'text',
  'subject',
]);

/** Who did it, as the Who column words it: a member, the support team, or the platform. */
export type AuditActorKind = 'member' | 'staff' | 'system';

/**
 * A staff write has no `actor_user_id` — staff are not workspace members — and marks
 * itself `meta.by = 'staff'`; without that mark a null actor is a schedule or a webhook.
 */
export function auditActorKind(entry: { actor: unknown; meta: Record<string, unknown> | null | undefined }): AuditActorKind {
  if (entry.actor) return 'member';
  return entry.meta?.by === 'staff' ? 'staff' : 'system';
}

const ROLES = new Set<string>(memberRole.options);
const TIERS = new Set<string>(planTier.options);
const REASONS = new Set<string>(reasonCode.options);

/**
 * The message key that words an id-valued fact (a role, a pack, a reason code), else null.
 * Built at runtime, so `messages.test.ts` cannot see it; `audit-view.test.ts` resolves every
 * key this can return against each catalogue (QA-070).
 */
export function valueKey(key: string, value: string): string | null {
  if ((key === 'role' || key === 'from' || key === 'to') && ROLES.has(value)) return `shell.role.${value}`;
  if (key === 'pack_id' && TIERS.has(value)) return `shell.tier.${value}`;
  if (key === 'reason_code' && REASONS.has(value)) return `dashboard.settings.audit.reasons.${value}`;
  return null;
}

export interface AuditMetaPair {
  /** The raw key; the table labels it through the message file. */
  key: string;
  /** A boolean is left for the table to word (yes/no is copy); everything else is data. */
  value: string | boolean;
  /** Set when the value is an id the message file words (`shell.role.admin`); the table shows that instead. */
  valueKey?: string;
}

/**
 * The metadata worth a line in the table — known keys only, scalars only, ids shortened.
 * Nested values are dropped: the writers only store flat facts, and anything else is
 * not something an owner reads.
 */
export function auditMetaPairs(meta: Record<string, unknown> | null | undefined, limit = 4): AuditMetaPair[] {
  if (!meta) return [];
  const out: AuditMetaPair[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (out.length >= limit) break;
    if (!KNOWN_AUDIT_META.has(key)) continue;
    if (value === null || value === undefined || value === '') continue;
    let text: string | boolean;
    if (typeof value === 'boolean') text = value;
    else if (typeof value === 'number') text = String(value);
    else if (typeof value === 'string') text = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) ? `${value.slice(0, 8)}…` : value.slice(0, 80);
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) text = value.join(', ').slice(0, 80);
    else continue;
    const wordedBy = typeof text === 'string' ? valueKey(key, text) : null;
    out.push(wordedBy ? { key, value: text, valueKey: wordedBy } : { key, value: text });
  }
  return out;
}
