-- D12 — admin console (28 Sep 2026, admin spec §4, §7.4, §8, §9).
--
-- users.locked_at / locked_reason   SA3 "Lock": AuthGuard refuses a locked sign-in and the
--                                   identity provider is blocked as well; the row is the
--                                   part that survives an Auth0 outage.
-- jobs.payload_json                 SA12 "Retry": the BullMQ payload the job was enqueued
--                                   with, re-enqueued verbatim by staff.
-- staff_audit_log.request_id        the Fastify request id, so an audit row matches a log line.
-- pricing_configs.stripe_sync_json  SA5 publish step 3: a version whose Stripe sync failed
--                                   keeps effective_at NULL and is never served (admin §5.2).
-- impersonation_sessions.ended_via  who ended a view-as session: admin, portal or expiry.
ALTER TABLE "users"
  ADD COLUMN "locked_at" TIMESTAMP(3),
  ADD COLUMN "locked_reason" TEXT;

ALTER TABLE "jobs"
  ADD COLUMN "payload_json" JSONB;

ALTER TABLE "staff_audit_log"
  ADD COLUMN "request_id" TEXT;

ALTER TABLE "pricing_configs"
  ADD COLUMN "stripe_sync_json" JSONB;

ALTER TABLE "impersonation_sessions"
  ADD COLUMN "ended_via" TEXT;

-- SA14 filters and the per-action lookups the console paginates on.
CREATE INDEX IF NOT EXISTS "staff_audit_log_action_created_at_idx" ON "staff_audit_log" ("action", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "jobs_status_created_at_idx" ON "jobs" ("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "webhook_events_unprocessed_idx" ON "webhook_events" ("received_at" DESC) WHERE "processed_at" IS NULL;
CREATE INDEX IF NOT EXISTS "impersonation_sessions_staff_open_idx" ON "impersonation_sessions" ("staff_id") WHERE "ended_at" IS NULL;
