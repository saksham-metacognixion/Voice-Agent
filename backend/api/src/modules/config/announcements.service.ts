import { Injectable } from '@nestjs/common';
import { adminDb, withWorkspace } from '@portal/db';
import type { ActiveAnnouncementsResponse } from '@portal/schemas';
import type { WorkspaceContext } from '../auth';
import { activeAnnouncements } from './announcements.rules';

/**
 * `GET /announcements/active` (§16, admin §5.3) — the SA10 banners this workspace should
 * see right now. Read on `adminDb` like pricing and flags: the table is staff-owned
 * configuration with no `tenant_id`, so RLS has nothing to scope it by, and the audience
 * is applied in code (`announcements.rules.ts`). The console writes the rows (D20);
 * nothing on the customer side does.
 */
@Injectable()
export class AnnouncementsService {
  async active(ctx: WorkspaceContext, now = new Date()): Promise<ActiveAnnouncementsResponse> {
    const tenant = await withWorkspace(ctx, (db) =>
      db.tenant.findUniqueOrThrow({ where: { id: ctx.workspaceId }, select: { planTier: true, country: true } }),
    );
    const facts = { tenantId: ctx.workspaceId, planTier: tenant.planTier, country: tenant.country };
    // The window is in the query and the cap counts rows this workspace is shown: a cap on
    // the rows read let future-dated banners and other workspaces' notices push an older
    // platform-wide one out of the answer. The audience is JSON, so it is applied per batch.
    const items: ActiveAnnouncementsResponse['items'] = [];
    for (let skip = 0; items.length < MAX_SHOWN && skip < SCAN_CEILING; skip += BATCH) {
      const rows = await adminDb.announcement.findMany({
        where: {
          type: 'banner',
          AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }, { OR: [{ startsAt: null }, { startsAt: { lte: now } }] }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: BATCH,
      });
      items.push(...activeAnnouncements(rows, facts, now));
      if (rows.length < BATCH) break;
    }
    return { items: items.slice(0, MAX_SHOWN) };
  }
}

/** Banners one workspace is sent at most. */
const MAX_SHOWN = 50;
const BATCH = 200;
/** Live banner rows read before giving up; far past anything staff keep open at once. */
const SCAN_CEILING = 2_000;
