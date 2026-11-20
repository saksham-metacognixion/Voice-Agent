-- ===========================================================================
-- D7 (22 Sep 2026) — recurring operations, alert state, notifications outbox,
-- call reconciliation. Recorded in ADR 0014.
--
-- Hand-written; `prisma migrate dev` will not regenerate the RLS, grants or the
-- partial indexes below (ADR 0006).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Alerts carry their own state: an open row per key blocks a duplicate, and
--    resolving it is what lets the next crossing alert again.
-- ---------------------------------------------------------------------------
ALTER TABLE "alerts"
  ADD COLUMN IF NOT EXISTS "key"         text,
  ADD COLUMN IF NOT EXISTS "resolved_at" timestamp(3),
  ADD COLUMN IF NOT EXISTS "meta_json"   jsonb;

CREATE INDEX IF NOT EXISTS "alerts_tenant_id_type_resolved_at_idx"
  ON "alerts" ("tenant_id", "type", "resolved_at");

-- Two schedule runs (or two workers) racing on the same crossing: one INSERT wins, the
-- other is ON CONFLICT DO NOTHING. That is the whole anti-spam guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS "alerts_open_key_idx"
  ON "alerts" ("tenant_id", "key")
  WHERE resolved_at IS NULL AND key IS NOT NULL;

COMMENT ON INDEX "alerts_open_key_idx" IS
  'One open alert per (workspace, key). Resolve it (resolved_at) before the same key may alert again (§5.4, §14.3).';

-- ---------------------------------------------------------------------------
-- 2. Notifications outbox: exactly one row per message we decided to send.
-- ---------------------------------------------------------------------------
CREATE TYPE "notification_status" AS ENUM ('pending', 'sent', 'skipped', 'failed');

CREATE TABLE "notifications" (
  "id"           uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"    uuid NOT NULL,
  "user_id"      uuid,
  "kind"         text NOT NULL,
  "dedupe_key"   text NOT NULL,
  "channel"      text NOT NULL,
  "recipient"    text,
  "subject"      text,
  "payload_json" jsonb,
  "status"       "notification_status" NOT NULL DEFAULT 'pending',
  "attempts"     integer NOT NULL DEFAULT 0,
  "error"        text,
  "sent_at"      timestamp(3),
  "created_at"   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications" ("dedupe_key");
CREATE INDEX "notifications_tenant_id_created_at_idx" ON "notifications" ("tenant_id", "created_at" DESC);
CREATE INDEX "notifications_status_created_at_idx" ON "notifications" ("status", "created_at");

COMMENT ON COLUMN "notifications"."dedupe_key" IS
  'digest:<ws>:<local date>, low_balance:<alert id>, rental_overdue:<alert id>, … — the exactly-once key for a message (D7).';

-- Written by the worker on the admin connection; the portal may read its own.
GRANT SELECT ON TABLE "notifications" TO portal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "notifications" TO portal_admin;

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_tenant_isolation ON "notifications" FOR ALL TO portal_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY notifications_admin_all ON "notifications" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. Number rental: the period markers, and the overdue clock (§5.3).
-- ---------------------------------------------------------------------------
ALTER TABLE "phone_numbers"
  ADD COLUMN IF NOT EXISTS "last_rental_at"       timestamp(3),
  ADD COLUMN IF NOT EXISTS "rental_overdue_since" timestamp(3);

CREATE INDEX IF NOT EXISTS "phone_numbers_next_rental_at_idx"
  ON "phone_numbers" ("next_rental_at")
  WHERE next_rental_at IS NOT NULL AND status IN ('active', 'paused');

-- A rental debit is idempotent on its ref_id (`<number id>:<period>`), the same way a
-- call debit is on its call id: two runs of the same period collide here and no-op.
-- Scoped to ref_type = 'number_rental', the tag the D7 job writes; the D1–D6 suites left
-- `rental` rows with free-form ref ids behind, and those must neither block the index
-- nor be mistaken for a period marker.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_rental_debit_once_idx"
  ON "credit_ledger" ("ref_id")
  WHERE reason = 'rental' AND ref_type = 'number_rental';

COMMENT ON INDEX "credit_ledger_rental_debit_once_idx" IS
  'One rental debit per (number, period), forever (§5.3). A re-run number-rental job hits this and no-ops.';

-- ---------------------------------------------------------------------------
-- 4. Reconciliation runs: global, admin-only, one row per window.
-- ---------------------------------------------------------------------------
CREATE TABLE "reconciliation_runs" (
  "id"                  uuid NOT NULL DEFAULT gen_random_uuid(),
  "window_start"        timestamp(3) NOT NULL,
  "window_end"          timestamp(3) NOT NULL,
  "status"              text NOT NULL,
  "provider_calls"      integer NOT NULL DEFAULT 0,
  "internal_calls"      integer NOT NULL DEFAULT 0,
  "matched_calls"       integer NOT NULL DEFAULT 0,
  "missing_ids"         jsonb,
  "extra_ids"           jsonb,
  "provider_seconds"    integer NOT NULL DEFAULT 0,
  "internal_seconds"    integer NOT NULL DEFAULT 0,
  "provider_cost_cents" integer NOT NULL DEFAULT 0,
  "internal_cost_cents" integer NOT NULL DEFAULT 0,
  "drift_pct"           decimal(8,3) NOT NULL DEFAULT 0,
  "threshold_pct"       decimal(8,3) NOT NULL,
  "alerted_at"          timestamp(3),
  "error"               text,
  "details_json"        jsonb,
  "created_at"          timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "reconciliation_runs_window_start_window_end_key"
  ON "reconciliation_runs" ("window_start", "window_end");
CREATE INDEX "reconciliation_runs_created_at_idx" ON "reconciliation_runs" ("created_at" DESC);

-- No tenant_id: nothing for portal_app to see. Deny by default (RLS on, no app policy).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "reconciliation_runs" TO portal_admin;
ALTER TABLE "reconciliation_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY reconciliation_runs_admin_all ON "reconciliation_runs" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);
