-- ===========================================================================
-- D6 (21 Sep 2026) — knowledge sources, phone plans and numbers, activation, billing.
--
-- Hand-written; `prisma migrate dev` will not regenerate the RLS, grants or the partial
-- indexes below (ADR 0006). Recorded in ADR 0013.
--
-- Nothing here references an enum value added in this file: Postgres refuses to *use* a
-- value in the transaction that adds it, and Prisma runs a migration as one transaction.
-- The knowledge default therefore moves by renaming `processing` → `pending`, which
-- rewrites the stored default in place.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Knowledge sources: explicit lifecycle, tenant anchor, payload until ingested.
-- ---------------------------------------------------------------------------
ALTER TYPE "knowledge_status" RENAME VALUE 'processing' TO 'pending';
ALTER TYPE "knowledge_status" ADD VALUE IF NOT EXISTS 'syncing' BEFORE 'ready';
ALTER TYPE "knowledge_status" ADD VALUE IF NOT EXISTS 'deleting';

ALTER TABLE "knowledge_sources"
  ADD COLUMN IF NOT EXISTS "tenant_id"    uuid,
  ADD COLUMN IF NOT EXISTS "url"          text,
  ADD COLUMN IF NOT EXISTS "content_type" text,
  ADD COLUMN IF NOT EXISTS "payload"      bytea,
  ADD COLUMN IF NOT EXISTS "sync_json"    jsonb,
  ADD COLUMN IF NOT EXISTS "synced_at"    timestamp(3),
  ADD COLUMN IF NOT EXISTS "updated_at"   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Nothing wrote knowledge_sources before D6, but the backfill is here so the constraint
-- below holds on any database that did.
UPDATE "knowledge_sources" k SET "tenant_id" = a."tenant_id"
  FROM "agents" a WHERE a."id" = k."agent_id" AND k."tenant_id" IS NULL;

ALTER TABLE "knowledge_sources"
  ALTER COLUMN "tenant_id" SET NOT NULL,
  ADD CONSTRAINT "knowledge_sources_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "knowledge_sources_tenant_id_idx" ON "knowledge_sources" ("tenant_id");

-- The standard tenant policy replaces the join through agents: same predicate every other
-- workspace table uses, one fewer join on every read.
DROP POLICY IF EXISTS knowledge_sources_tenant_isolation ON "knowledge_sources";
CREATE POLICY knowledge_sources_tenant_isolation ON "knowledge_sources" FOR ALL TO portal_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

COMMENT ON COLUMN "knowledge_sources"."payload" IS
  'File or text bytes held only until the voice platform has ingested them; the sync job NULLs it.';
COMMENT ON COLUMN "knowledge_sources"."sync_json" IS
  'Internal sync ledger (attempts, platform status, raw error). Never returned to a customer.';

-- ---------------------------------------------------------------------------
-- 2. Phone plans: one pending plan per agent, routing fields, Option B carrier.
-- ---------------------------------------------------------------------------
ALTER TABLE "phone_plans"
  ADD COLUMN IF NOT EXISTS "carrier"             text,
  ADD COLUMN IF NOT EXISTS "hours_override_json" jsonb,
  ADD COLUMN IF NOT EXISTS "nickname"            text,
  ADD COLUMN IF NOT EXISTS "updated_at"          timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "phone_plans_agent_id_status_idx" ON "phone_plans" ("agent_id", "status");

-- PUT /agents/:id/phone-plan replaces the pending plan; two racing PUTs cannot leave two.
CREATE UNIQUE INDEX IF NOT EXISTS "phone_plans_one_pending_per_agent_idx"
  ON "phone_plans" ("agent_id") WHERE status = 'pending';

COMMENT ON COLUMN "phone_plans"."sip_json" IS
  'Option C: {number, host, username, password: <envelope v1>}. The password is AES-256-GCM under a KMS-wrapped data key; never in clear.';

-- ---------------------------------------------------------------------------
-- 3. Phone numbers: e164 arrives from the platform, one number per plan, Option B state.
-- ---------------------------------------------------------------------------
ALTER TYPE "phone_number_status" ADD VALUE IF NOT EXISTS 'failed';

CREATE TYPE "forwarding_status" AS ENUM ('waiting_for_customer', 'ready', 'failed');

ALTER TABLE "phone_numbers"
  ALTER COLUMN "e164" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "plan_id"           uuid,
  ADD COLUMN IF NOT EXISTS "forwarding_from"   text,
  ADD COLUMN IF NOT EXISTS "forwarding_status" "forwarding_status",
  ADD COLUMN IF NOT EXISTS "carrier"           text,
  ADD COLUMN IF NOT EXISTS "error"             text,
  ADD COLUMN IF NOT EXISTS "released_at"       timestamp(3),
  ADD COLUMN IF NOT EXISTS "updated_at"        timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "phone_numbers"
  ADD CONSTRAINT "phone_numbers_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "phone_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One number per plan: the activation job's provision step is idempotent on this.
CREATE UNIQUE INDEX IF NOT EXISTS "phone_numbers_plan_id_key" ON "phone_numbers" ("plan_id");

COMMENT ON COLUMN "phone_numbers"."e164" IS
  'NULL while a bought number is still being provisioned. The hot path key num:{e164} is only written once it is set.';

-- ---------------------------------------------------------------------------
-- 4. Purchases: one row per PaymentIntent (auto top-up replay guard), failure trail.
-- ---------------------------------------------------------------------------
ALTER TABLE "purchases"
  ADD COLUMN IF NOT EXISTS "failure_reason" text,
  ADD COLUMN IF NOT EXISTS "updated_at"     timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS "purchases_stripe_payment_intent_key" ON "purchases" ("stripe_payment_intent");
CREATE INDEX IF NOT EXISTS "purchases_tenant_id_is_auto_topup_status_idx" ON "purchases" ("tenant_id", "is_auto_topup", "status");

-- ---------------------------------------------------------------------------
-- 5. Invoices: a mirror of Stripe's invoice lifecycle (D5 "Invoices", SA9).
-- ---------------------------------------------------------------------------
CREATE TYPE "invoice_status" AS ENUM ('draft', 'open', 'paid', 'payment_failed', 'void', 'uncollectible');

CREATE TABLE "invoices" (
  "id"                    uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"             uuid,
  "purchase_id"           uuid,
  "stripe_invoice_id"     text NOT NULL,
  "stripe_customer_id"    text,
  "stripe_payment_intent" text,
  "number"                text,
  "amount_cents"          integer NOT NULL,
  "amount_paid_cents"     integer NOT NULL DEFAULT 0,
  "currency"              char(3) NOT NULL,
  "status"                "invoice_status" NOT NULL,
  "hosted_url"            text,
  "pdf_url"               text,
  "last_event_id"         text,
  "last_event_created"    integer,
  "finalized_at"          timestamp(3),
  "paid_at"               timestamp(3),
  "voided_at"             timestamp(3),
  "created_at"            timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "invoices_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "invoices_stripe_invoice_id_key" ON "invoices" ("stripe_invoice_id");
CREATE INDEX "invoices_tenant_id_created_at_idx" ON "invoices" ("tenant_id", "created_at" DESC);
CREATE INDEX "invoices_stripe_customer_id_idx" ON "invoices" ("stripe_customer_id");

-- Written by webhooks (admin connection); customers only read their own.
GRANT SELECT ON TABLE "invoices" TO portal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "invoices" TO portal_admin;

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY invoices_tenant_isolation ON "invoices" FOR ALL TO portal_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY invoices_admin_all ON "invoices" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);
