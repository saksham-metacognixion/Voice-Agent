import type { AnnouncementResponse, AnnouncementSeverity, PlanTier } from '@portal/schemas';
import { announcementSeverity } from '@portal/schemas';

/**
 * Which staff banners (admin §8 `announcements`, SA10) a workspace sees, as a pure rule
 * (ADR 0041). The console writes the rows; the portal reads them through
 * `GET /announcements/active`; nothing here writes.
 */

export interface AnnouncementRow {
  id: string;
  type: string;
  body: string;
  severity: string;
  audienceJson: unknown;
  startsAt: Date | null;
  endsAt: Date | null;
  dismissible: boolean;
  createdAt: Date;
}

export interface AudienceFacts {
  tenantId: string;
  planTier: PlanTier | string;
  country: string;
}

/**
 * SA10's audience: all / plan / country / list. Stored as `{all?, plans?, countries?, tenant_ids?}`;
 * null, `{}` or `{all: true}` is everyone, and the other lists narrow it — a workspace must
 * match every list that is present. An unreadable value reaches nobody: a banner is staff
 * copy shown to customers, and the safe failure of a bad filter is silence, not broadcast.
 */
export function audienceIncludes(audience: unknown, facts: AudienceFacts): boolean {
  if (audience === null || audience === undefined) return true;
  if (typeof audience !== 'object' || Array.isArray(audience)) return false;
  const a = audience as Record<string, unknown>;
  if (a.all === true) return true;
  const lists = (['plans', 'countries', 'tenant_ids'] as const).filter((k) => a[k] !== undefined);
  if (lists.length === 0) return Object.keys(a).length === 0;
  const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
  for (const key of lists) {
    const list = strings(a[key]);
    if (!list) return false;
    const wanted = key === 'plans' ? String(facts.planTier) : key === 'countries' ? facts.country : facts.tenantId;
    if (!list.map((x) => x.toLowerCase()).includes(wanted.toLowerCase())) return false;
  }
  return true;
}

/** A banner is live between its start (or creation) and its end; no end = until it is withdrawn. */
export function isLive(row: Pick<AnnouncementRow, 'type' | 'startsAt' | 'endsAt'>, now: Date): boolean {
  if (row.type !== 'banner') return false;
  if (row.startsAt && row.startsAt.getTime() > now.getTime()) return false;
  if (row.endsAt && row.endsAt.getTime() <= now.getTime()) return false;
  return true;
}

export function severityOf(value: string): AnnouncementSeverity {
  const parsed = announcementSeverity.safeParse(value);
  return parsed.success ? parsed.data : 'info';
}

/** The rows one workspace sees, newest first. */
export function activeAnnouncements(rows: AnnouncementRow[], facts: AudienceFacts, now: Date): AnnouncementResponse[] {
  return rows
    .filter((row) => isLive(row, now) && audienceIncludes(row.audienceJson, facts))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((row) => ({
      id: row.id,
      severity: severityOf(row.severity),
      body: row.body,
      starts_at: row.startsAt?.toISOString() ?? null,
      ends_at: row.endsAt?.toISOString() ?? null,
      dismissible: row.dismissible,
      created_at: row.createdAt.toISOString(),
    }));
}
