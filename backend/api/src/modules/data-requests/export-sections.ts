import { csvCell } from '../calls/csv';

/*
 * The files of the D6 "Export all data" zip (QA-081, spec p. 39, §17) and how a row of
 * each becomes a line. Pure, so what leaves the building is pinned by a unit test.
 *
 * What is deliberately not in any file: platform identifiers (agent, LLM, knowledge-base,
 * phone-number ids of the voice platform — and the `carrier`, which names it), a number's
 * inbound webhook token (an unguessable path segment that authorises the §13.9 hot path),
 * SIP credentials or hosts, Stripe customer / payment-method / session ids, invite token
 * hashes, knowledge payload bytes (the sources the customer uploaded are theirs already;
 * the platform holds the ingested copy), COGS, staff notes and internal ticket messages.
 */

/** Rows per section. Each is bounded; the manifest says when a section hit its cap. */
export const EXPORT_SECTION_MAX_ROWS = 10_000;
/** Versions carry a whole prompt each, so they are capped lower and read in smaller batches. */
export const EXPORT_VERSIONS_MAX_ROWS = 2_000;

type Cell = string | number | boolean | null | undefined;

export function csvLine(cells: readonly Cell[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);
const json = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

export const MEMBER_COLUMNS = ['membership_id', 'user_id', 'name', 'email', 'role', 'joined_at'] as const;
export function memberLine(row: { id: string; userId: string; role: string; createdAt: Date; user: { name: string | null; email: string } }): string {
  return csvLine([row.id, row.userId, row.user.name, row.user.email, row.role, iso(row.createdAt)]);
}

export const INVITE_COLUMNS = ['invite_id', 'email', 'role', 'invited_by', 'created_at', 'expires_at', 'accepted_at'] as const;
export function inviteLine(row: { id: string; email: string; role: string; invitedBy: string; createdAt: Date; expiresAt: Date; acceptedAt: Date | null }): string {
  return csvLine([row.id, row.email, row.role, row.invitedBy, iso(row.createdAt), iso(row.expiresAt), iso(row.acceptedAt)]);
}

export const NUMBER_COLUMNS = [
  'number_id',
  'e164',
  'nickname',
  'kind',
  'country',
  'area_code',
  'requested_area_code',
  'toll_free',
  'status',
  'agent_id',
  'hours_mode',
  'hours_override',
  'transfer_targets',
  'transfer_fail_message',
  'allowed_countries',
  'blocklist',
  'forwarding_from',
  'forwarding_status',
  'created_at',
  'released_at',
] as const;
export function numberLine(row: {
  id: string;
  e164: string | null;
  nickname: string | null;
  type: string;
  country: string | null;
  areaCode: string | null;
  requestedAreaCode: string | null;
  tollFree: boolean;
  status: string;
  agentId: string | null;
  hoursMode: string;
  hoursOverrideJson: unknown;
  transferTargetsJson: unknown;
  transferFailMessage: string | null;
  allowedCountries: string[];
  blocklist: string[];
  forwardingFrom: string | null;
  forwardingStatus: string | null;
  createdAt: Date;
  releasedAt: Date | null;
}): string {
  return csvLine([
    row.id,
    row.e164,
    row.nickname,
    // `bought` or `sip`, as `phoneNumberResponse` says it: the stored type names the vendor.
    row.type === 'custom_sip' ? 'sip' : 'bought',
    row.country,
    row.areaCode,
    row.requestedAreaCode,
    row.tollFree,
    row.status,
    row.agentId,
    row.hoursMode,
    json(row.hoursOverrideJson),
    json(row.transferTargetsJson),
    row.transferFailMessage,
    row.allowedCountries.join(' '),
    row.blocklist.join(' '),
    row.forwardingFrom,
    row.forwardingStatus,
    iso(row.createdAt),
    iso(row.releasedAt),
  ]);
}

export const PURCHASE_COLUMNS = ['purchase_id', 'pack_id', 'credits', 'amount_cents', 'currency', 'status', 'is_auto_topup', 'promo_code', 'created_at'] as const;
export function purchaseLine(row: { id: string; packId: string | null; credits: number; amountCents: number; currency: string; status: string; isAutoTopup: boolean; promoCode: string | null; createdAt: Date }): string {
  return csvLine([row.id, row.packId, row.credits, row.amountCents, row.currency, row.status, row.isAutoTopup, row.promoCode, iso(row.createdAt)]);
}

export const INVOICE_COLUMNS = ['invoice_id', 'number', 'purchase_id', 'status', 'amount_cents', 'amount_paid_cents', 'currency', 'hosted_url', 'pdf_url', 'finalized_at', 'paid_at', 'voided_at', 'created_at'] as const;
export function invoiceLine(row: {
  id: string;
  number: string | null;
  purchaseId: string | null;
  status: string;
  amountCents: number;
  amountPaidCents: number;
  currency: string;
  hostedUrl: string | null;
  pdfUrl: string | null;
  finalizedAt: Date | null;
  paidAt: Date | null;
  voidedAt: Date | null;
  createdAt: Date;
}): string {
  return csvLine([row.id, row.number, row.purchaseId, row.status, row.amountCents, row.amountPaidCents, row.currency, row.hostedUrl, row.pdfUrl, iso(row.finalizedAt), iso(row.paidAt), iso(row.voidedAt), iso(row.createdAt)]);
}

export const KNOWLEDGE_COLUMNS = ['source_id', 'agent_id', 'type', 'role', 'name', 'url', 'content_type', 'status', 'size_bytes', 'error', 'synced_at', 'created_at'] as const;
export function knowledgeLine(row: { id: string; agentId: string; type: string; role: string | null; name: string; url: string | null; contentType: string | null; status: string; sizeBytes: number | null; error: string | null; syncedAt: Date | null; createdAt: Date }): string {
  return csvLine([row.id, row.agentId, row.type, row.role, row.name, row.url, row.contentType, row.status, row.sizeBytes, row.error, iso(row.syncedAt), iso(row.createdAt)]);
}

export const AUDIT_COLUMNS = ['entry_id', 'created_at', 'action', 'actor_user_id', 'actor_email', 'target_type', 'target_id', 'ip', 'meta'] as const;
export function auditLine(row: { id: string; createdAt: Date; action: string; actorUserId: string | null; actor: { email: string } | null; targetType: string | null; targetId: string | null; ip: string | null; metaJson: unknown }): string {
  return csvLine([row.id, iso(row.createdAt), row.action, row.actorUserId, row.actor?.email ?? null, row.targetType, row.targetId, row.ip, json(row.metaJson)]);
}

/** One agent as `agents.json` carries it: the customer's configuration, no platform ids. */
export function agentJson(row: {
  id: string;
  name: string;
  templateId: string | null;
  industry: string | null;
  tier: string;
  primaryLanguage: string;
  languages: string[];
  voiceId: string | null;
  status: string;
  draftVersion: number | null;
  publishedVersion: number | null;
  maxCallDurationS: number;
  recordingEnabled: boolean;
  widgetEnabled: boolean;
  widgetOrigins: string[];
  createdAt: Date;
}): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    template_id: row.templateId,
    industry: row.industry,
    tier: row.tier,
    primary_language: row.primaryLanguage,
    languages: row.languages,
    voice_id: row.voiceId,
    status: row.status,
    draft_version: row.draftVersion,
    published_version: row.publishedVersion,
    max_call_duration_s: row.maxCallDurationS,
    recording_enabled: row.recordingEnabled,
    widget_enabled: row.widgetEnabled,
    widget_origins: row.widgetOrigins,
    created_at: iso(row.createdAt),
  };
}

/** One version as `agent_versions.json` carries it: the brief, the settings and the script. */
export function versionJson(row: {
  agentId: string;
  versionNo: number;
  source: string;
  briefJson: unknown;
  settingsJson: unknown;
  promptText: string | null;
  greeting: string | null;
  closing: string | null;
  analysisSchemaJson: unknown;
  feedbackText: string | null;
  publishedAt: Date | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    agent_id: row.agentId,
    version_no: row.versionNo,
    source: row.source,
    brief: row.briefJson ?? null,
    settings: row.settingsJson ?? null,
    prompt: row.promptText,
    greeting: row.greeting,
    closing: row.closing,
    analysis_fields: row.analysisSchemaJson ?? null,
    feedback: row.feedbackText,
    published_at: iso(row.publishedAt),
    created_at: iso(row.createdAt),
  };
}

/** `workspace.json`: the settings the customer can see in D6, never billing-provider ids. */
export function workspaceJson(row: {
  id: string;
  name: string;
  country: string;
  timezone: string;
  addressJson: unknown;
  website: string | null;
  planTier: string;
  concurrencyCap: number;
  kbAllowance: number;
  businessHoursJson: unknown;
  autoTopupJson: unknown;
  recordingDefault: boolean;
  retentionDays: number;
  onboardingCompletedAt: Date | null;
  pausedAt: Date | null;
  kycStatus: string;
  createdAt: Date;
}): Record<string, unknown> {
  const topup = row.autoTopupJson && typeof row.autoTopupJson === 'object' ? (row.autoTopupJson as Record<string, unknown>) : null;
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    timezone: row.timezone,
    address: row.addressJson ?? null,
    website: row.website,
    plan_tier: row.planTier,
    concurrency_cap: row.concurrencyCap,
    kb_allowance: row.kbAllowance,
    business_hours: row.businessHoursJson ?? null,
    // The card's provider id stays behind; whether top-up is on and at what is the customer's.
    auto_topup: topup ? { enabled: topup.enabled === true, pack_id: topup.pack_id ?? null, threshold: topup.threshold ?? null } : null,
    recording_default: row.recordingDefault,
    retention_days: row.retentionDays,
    onboarding_completed_at: iso(row.onboardingCompletedAt),
    paused: row.pausedAt !== null,
    business_verification: row.kycStatus,
    created_at: iso(row.createdAt),
  };
}
