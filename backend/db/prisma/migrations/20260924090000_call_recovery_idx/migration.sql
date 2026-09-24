-- ADR 0011 §7: the 5-minute `call-recovery` schedule asks, across every workspace, which
-- calls never got their `call_ended` (still registered / in_progress) and which ended
-- without analysis. Both are tiny, shrinking sets on a table that only grows, so each
-- gets a partial index instead of a scan of `calls` every tick. Partial indexes are not
-- expressible in schema.prisma; like the ledger's idempotency indexes they live here only.
CREATE INDEX "calls_unsettled_created_at_idx" ON "calls" ("created_at" DESC)
  WHERE "status" IN ('registered', 'in_progress');
CREATE INDEX "calls_unanalysed_ended_at_idx" ON "calls" ("ended_at" DESC)
  WHERE "status" = 'ended' AND "analysis_json" IS NULL;
