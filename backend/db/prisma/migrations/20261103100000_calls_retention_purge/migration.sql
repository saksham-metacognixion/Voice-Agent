-- ADR 0035 (3 Nov 2026), audit 29 Oct §6.1 #2: §17 retention is enforced by the hourly
-- `data-retention` job (CallRetentionService). A purged call keeps its billing facts and
-- analysis and loses its transcript, its recording link and the stored webhook bodies'
-- copies of them; `purged_at` is set only once the platform's delete-call has answered
-- (200 or 404), so a provider failure is retried (`purge_attempts`, `purge_error`) and never
-- marks a call purged by mistake.
ALTER TABLE "calls"
  ADD COLUMN "purged_at" TIMESTAMPTZ,
  ADD COLUMN "purge_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "purge_error" TEXT;

-- The sweep's candidate scan: rows not yet purged, oldest first. Partial, so a purged row
-- costs nothing here. Hand-written (Prisma has no partial indexes).
CREATE INDEX "calls_retention_pending_idx" ON "calls" ("created_at") WHERE "purged_at" IS NULL;
