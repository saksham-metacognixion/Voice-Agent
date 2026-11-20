-- D16 (P2): transfer billing, knowledge-use statistics and SIP re-verification.

-- 1. Transfer leg on the call row. Billed apart from the agent leg; every column is a fact
--    from a transfer_* event or a projection of the `transfer` ledger row.
ALTER TABLE "calls"
  ADD COLUMN "transfer_status" TEXT,
  ADD COLUMN "transfer_started_at" TIMESTAMP(3),
  ADD COLUMN "transfer_bridged_at" TIMESTAMP(3),
  ADD COLUMN "transfer_ended_at" TIMESTAMP(3),
  ADD COLUMN "transfer_duration_s" INTEGER,
  ADD COLUMN "transfer_rate" DECIMAL(6,3),
  ADD COLUMN "transfer_credits_charged" DECIMAL(12,2);

ALTER TABLE "calls"
  ADD CONSTRAINT "calls_transfer_status_check"
  CHECK ("transfer_status" IS NULL OR "transfer_status" IN ('started', 'bridged', 'cancelled', 'ended'));

-- The same shape as the call debit: one transfer debit per call, forever. A replayed or
-- out-of-order transfer_ended collides here instead of billing the leg twice.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_transfer_debit_once_idx"
  ON "credit_ledger" ("ref_id")
  WHERE reason = 'transfer';

COMMENT ON INDEX "credit_ledger_transfer_debit_once_idx" IS
  'One transferred-leg debit per call, forever (D16). A replayed transfer_ended hits this and no-ops.';

-- 2. Knowledge use per call. NULL = not consulted; computed from the platform's payload and
--    written with SET, never incremented, so a replay recomputes the same numbers.
ALTER TABLE "calls"
  ADD COLUMN "kb_retrievals" INTEGER,
  ADD COLUMN "kb_hits" INTEGER,
  ADD COLUMN "kb_usage_json" JSONB;

-- 3. SIP re-verify: the outcome and the lease. No credential is ever stored here.
ALTER TABLE "phone_numbers"
  ADD COLUMN "sip_verification_json" JSONB,
  ADD COLUMN "sip_verify_started_at" TIMESTAMP(3);
