-- D18 (P2): outbound click-to-call behind its compliance gates (ADR 0031).
-- Hand-written: `prisma migrate dev` will not regenerate the RLS, grants or triggers.

-- ---------------------------------------------------------------------------
-- 1. Business verification (KYC) and the outbound settings, on the workspace.
-- ---------------------------------------------------------------------------
CREATE TYPE "kyc_status" AS ENUM ('none', 'pending', 'verified', 'rejected');

ALTER TABLE "tenants"
  ADD COLUMN "kyc_status" "kyc_status" NOT NULL DEFAULT 'none',
  ADD COLUMN "kyc_json" JSONB,
  ADD COLUMN "kyc_submitted_at" TIMESTAMP(3),
  ADD COLUMN "kyc_decided_at" TIMESTAMP(3),
  ADD COLUMN "kyc_reason" TEXT,
  ADD COLUMN "outbound_settings_json" JSONB;

-- ---------------------------------------------------------------------------
-- 2. Caller ID verification, per number. A number bought on the platform is ours and is
--    verified by the purchase; backfill the ones already live. A SIP import waits for staff.
-- ---------------------------------------------------------------------------
ALTER TABLE "phone_numbers"
  ADD COLUMN "caller_id_verified_at" TIMESTAMP(3),
  ADD COLUMN "caller_id_verified_via" TEXT;

UPDATE "phone_numbers"
   SET "caller_id_verified_at" = "created_at", "caller_id_verified_via" = 'purchase'
 WHERE "type" <> 'custom_sip' AND "e164" IS NOT NULL AND "status" IN ('active', 'paused');

-- The customer's connection may update `tenants` and `phone_numbers` (settings, routing),
-- so RLS alone would let a bug on a customer path mark a workspace verified. These columns
-- are staff decisions: only the admin role may set a verdict or a caller ID. The customer
-- may move KYC to `pending` (a submission) and nothing else.
CREATE OR REPLACE FUNCTION app.guard_outbound_verdicts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(current_user, 'portal_admin', 'MEMBER') OR NOT pg_has_role(current_user, 'portal_app', 'MEMBER') THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'tenants' THEN
    IF NEW.kyc_status IS DISTINCT FROM OLD.kyc_status AND NEW.kyc_status <> 'pending' THEN
      RAISE EXCEPTION 'kyc_status % may only be set by staff', NEW.kyc_status USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.kyc_decided_at IS DISTINCT FROM OLD.kyc_decided_at AND NEW.kyc_decided_at IS NOT NULL THEN
      RAISE EXCEPTION 'kyc_decided_at may only be set by staff' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF TG_TABLE_NAME = 'phone_numbers' THEN
    IF NEW.caller_id_verified_at IS DISTINCT FROM OLD.caller_id_verified_at
       OR NEW.caller_id_verified_via IS DISTINCT FROM OLD.caller_id_verified_via THEN
      RAISE EXCEPTION 'caller ID verification may only be set by staff or provisioning' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_guard_outbound_verdicts BEFORE UPDATE ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION app.guard_outbound_verdicts();
CREATE TRIGGER phone_numbers_guard_outbound_verdicts BEFORE UPDATE ON "phone_numbers"
  FOR EACH ROW EXECUTE FUNCTION app.guard_outbound_verdicts();

-- ---------------------------------------------------------------------------
-- 3. Outbound attempts that passed the checks: what the daily cap counts, and what makes
--    a double click one call (`idempotency_key`).
-- ---------------------------------------------------------------------------
CREATE TYPE "outbound_call_status" AS ENUM ('pending', 'placed', 'failed');

CREATE TABLE "outbound_calls" (
  "id"              uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"       uuid NOT NULL,
  "requested_by"    uuid,
  "idempotency_key" uuid NOT NULL,
  "source_call_id"  text NOT NULL,
  "call_id"         text,
  "agent_id"        uuid,
  "number_id"       uuid,
  "to_number"       text NOT NULL,
  "from_number"     text NOT NULL,
  "local_day"       date NOT NULL,
  "status"          "outbound_call_status" NOT NULL DEFAULT 'pending',
  "voicemail"       text NOT NULL,
  "failure"         text,
  "created_at"      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outbound_calls_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "outbound_calls_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "outbound_calls_number_id_fkey" FOREIGN KEY ("number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "outbound_calls_call_id_key" ON "outbound_calls" ("call_id");
CREATE UNIQUE INDEX "outbound_calls_tenant_id_idempotency_key_key" ON "outbound_calls" ("tenant_id", "idempotency_key");
CREATE INDEX "outbound_calls_tenant_id_local_day_idx" ON "outbound_calls" ("tenant_id", "local_day");

GRANT SELECT, INSERT, UPDATE ON TABLE "outbound_calls" TO portal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "outbound_calls" TO portal_admin;

ALTER TABLE "outbound_calls" ENABLE ROW LEVEL SECURITY;
CREATE POLICY outbound_calls_tenant_isolation ON "outbound_calls" FOR ALL TO portal_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY outbound_calls_admin_all ON "outbound_calls" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 4. The workspace's own do-not-call list.
-- ---------------------------------------------------------------------------
CREATE TABLE "dnc_entries" (
  "id"         uuid NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"  uuid NOT NULL,
  "e164"       text NOT NULL,
  "source"     text NOT NULL,
  "reason"     text,
  "created_by" uuid,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dnc_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dnc_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "dnc_entries_tenant_id_e164_key" ON "dnc_entries" ("tenant_id", "e164");

GRANT SELECT, INSERT, DELETE ON TABLE "dnc_entries" TO portal_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "dnc_entries" TO portal_admin;

ALTER TABLE "dnc_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dnc_entries_tenant_isolation ON "dnc_entries" FOR ALL TO portal_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY dnc_entries_admin_all ON "dnc_entries" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);
