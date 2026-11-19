-- ADR 0049: USD and CAD. Additive only (ADR 0034): every column is new and nullable or
-- defaulted, so the previous image keeps running on this schema.

-- 1. The daily USD/CAD rate, kept as history. One row per (source, pair, business day);
--    a refresh that finds the same day again only moves `confirmed_at`, which is what
--    "last successful refresh" reads. Rates are never updated or deleted by the app.
CREATE TABLE "exchange_rates" (
  "id"             UUID           NOT NULL DEFAULT gen_random_uuid(),
  "base_currency"  CHAR(3)        NOT NULL,
  "quote_currency" CHAR(3)        NOT NULL,
  "rate"           DECIMAL(14, 8) NOT NULL,
  "observed_on"    DATE           NOT NULL,
  "source"         TEXT           NOT NULL,
  "series"         TEXT           NOT NULL,
  "fetched_at"     TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "confirmed_at"   TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "exchange_rates_rate_positive" CHECK ("rate" > 0)
);
CREATE UNIQUE INDEX "exchange_rates_source_pair_day_key"
  ON "exchange_rates" ("source", "base_currency", "quote_currency", "observed_on");
CREATE INDEX "exchange_rates_pair_day_idx"
  ON "exchange_rates" ("base_currency", "quote_currency", "observed_on" DESC);

-- No tenant_id: nothing for portal_app to see. Deny by default (RLS on, no app policy),
-- like `platform_settings`. No DELETE grant: history stays.
GRANT SELECT, INSERT, UPDATE ON TABLE "exchange_rates" TO portal_admin;
ALTER TABLE "exchange_rates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY exchange_rates_admin_all ON "exchange_rates" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);

-- 2. The workspace currency. Every purchase so far was charged in USD, so a workspace
--    that has paid, or has a payment or a review in progress, stays USD. A Canadian
--    workspace with none of those starts in CAD, the default a new one gets; its owner
--    can change it back until the first purchase.
ALTER TABLE "tenants" ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_currency_supported" CHECK ("currency" IN ('USD', 'CAD'));

UPDATE "tenants" t
SET "currency" = 'CAD'
WHERE t."country" = 'CA'
  AND NOT EXISTS (
    SELECT 1 FROM "purchases" p
    WHERE p."tenant_id" = t."id"
      AND p."status" IN ('paid', 'refunded', 'pending', 'in_review', 'approved')
  );

-- 3. What a purchase was priced from: the published base price, and the rate that turned
--    it into the amount charged. NULL rate = no conversion (a base-currency purchase).
ALTER TABLE "purchases" ADD COLUMN "base_amount_cents" INTEGER;
ALTER TABLE "purchases" ADD COLUMN "base_currency" CHAR(3);
ALTER TABLE "purchases" ADD COLUMN "fx_rate" DECIMAL(14, 8);
ALTER TABLE "purchases" ADD COLUMN "fx_rate_date" DATE;
ALTER TABLE "purchases" ADD COLUMN "fx_rate_id" UUID;
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_fx_rate_id_fkey"
  FOREIGN KEY ("fx_rate_id") REFERENCES "exchange_rates" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rows from before this migration were all charged at their published price.
UPDATE "purchases" SET "base_amount_cents" = "amount_cents", "base_currency" = "currency"
WHERE "base_amount_cents" IS NULL;

-- 4. Defence in depth, like `guard_number_staff_pause`: once a purchase has been paid the
--    customer's database role cannot change the workspace currency, whatever a service
--    does. Staff (portal_admin) can, with a reason code and an audit row.
CREATE OR REPLACE FUNCTION app.guard_tenant_currency() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency IS NOT DISTINCT FROM OLD.currency THEN
    RETURN NEW;
  END IF;
  IF pg_has_role(current_user, 'portal_admin', 'MEMBER') OR NOT pg_has_role(current_user, 'portal_app', 'MEMBER') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM purchases p WHERE p.tenant_id = NEW.id AND p.status IN ('paid', 'refunded')) THEN
    RAISE EXCEPTION 'the workspace currency is locked after the first purchase' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_guard_currency BEFORE UPDATE ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION app.guard_tenant_currency();
