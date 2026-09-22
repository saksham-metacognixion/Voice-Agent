-- D7 review: the 15-minute low-balance sweep asks "which workspaces had a ledger row in the
-- last 45 minutes" instead of summing the whole append-only ledger every tick. The existing
-- (tenant_id, created_at DESC) index cannot answer a cross-tenant time-range query, so the
-- sweep gets an index of its own.
CREATE INDEX "credit_ledger_created_at_idx" ON "credit_ledger"("created_at");
