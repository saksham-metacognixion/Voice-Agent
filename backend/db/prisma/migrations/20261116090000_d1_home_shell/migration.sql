-- D1 Home and the §7.2 shell (ADR 0041). Additive only (ADR 0034).
--
-- 1. A staff pause names its ticket: "Your account is paused — see ticket #…" (D1).
ALTER TABLE "tenants" ADD COLUMN "paused_ticket_id" INTEGER;

-- 2. Who paused an agent, and under which ticket when it was staff. The D1 card tells a
--    customer's own pause from a staff one; nothing else reads them.
ALTER TABLE "agents" ADD COLUMN "paused_by" TEXT;
ALTER TABLE "agents" ADD COLUMN "paused_ticket_id" INTEGER;

-- 3. The bell's read marker, per member: rows in the notifications outbox created after
--    it are unread. The outbox itself is unchanged (D7).
ALTER TABLE "memberships" ADD COLUMN "notifications_seen_at" TIMESTAMP(3);

-- The feed reads the caller's own rows and the workspace-level ones (user_id NULL) by
-- creation time; the existing (tenant_id, created_at DESC) index serves it.
