-- ADR 0036 (3 Nov 2026), audit 29 Oct rows A-12, A-22, A-24 and SEC-10. Additive only:
-- an older image keeps working on this schema (ADR 0034).

-- §17 "manual review flag for > $1,000 first purchase". A purchase over the limit waits in
-- `in_review` with no Stripe session; staff move it to `approved` (the customer may then
-- pay) or `rejected`. Nothing is charged before approval, so a rejection refunds nothing.
ALTER TYPE "purchase_status" ADD VALUE IF NOT EXISTS 'in_review';
ALTER TYPE "purchase_status" ADD VALUE IF NOT EXISTS 'approved';
ALTER TYPE "purchase_status" ADD VALUE IF NOT EXISTS 'rejected';

-- The review is the existing staff-only `fraud_reviews` row, now naming its purchase and
-- the amount it was asked for, and when it was decided.
ALTER TABLE "fraud_reviews"
  ADD COLUMN "purchase_id"  UUID,
  ADD COLUMN "amount_cents" INTEGER,
  ADD COLUMN "currency"     CHAR(3),
  ADD COLUMN "decided_at"   TIMESTAMP(3);
ALTER TABLE "fraud_reviews" ADD CONSTRAINT "fraud_reviews_purchase_id_fkey"
  FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "fraud_reviews_purchase_id_key" ON "fraud_reviews"("purchase_id");
-- One open first-purchase review per workspace: a double click, a second tab or a retry
-- joins the open one instead of queueing a second.
CREATE UNIQUE INDEX "fraud_reviews_one_open_first_purchase_idx" ON "fraud_reviews"("tenant_id")
  WHERE "status" = 'open' AND "trigger" = 'first_purchase_over_limit';

-- §6.3 A1: the Terms checkbox. `users.tos_accepted_at` (spec §15) stays the latest
-- acceptance; `tos_version` says which; every acceptance is also a row of its own, so a
-- later version never overwrites the record of an earlier one.
ALTER TABLE "users" ADD COLUMN "tos_version" TEXT;

CREATE TABLE "terms_acceptances" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "user_id"     UUID         NOT NULL,
  "version"     TEXT         NOT NULL,
  "accepted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip"          TEXT,
  "user_agent"  TEXT,

  CONSTRAINT "terms_acceptances_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "terms_acceptances" ADD CONSTRAINT "terms_acceptances_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- One row per person per version: accepting the same version twice records nothing new.
CREATE UNIQUE INDEX "terms_acceptances_user_version_key" ON "terms_acceptances"("user_id", "version");

-- Account-level, no tenant_id: written and read on the admin connection only. portal_app
-- gets no grant, and RLS with no app policy is the second lock.
GRANT SELECT, INSERT ON TABLE "terms_acceptances" TO portal_admin;
ALTER TABLE "terms_acceptances" ENABLE ROW LEVEL SECURITY;
CREATE POLICY terms_acceptances_admin_all ON "terms_acceptances" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);
