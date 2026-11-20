-- D18 (ADR 0031): the outbound verdicts are refused from `portal_app` on INSERT as well as
-- UPDATE. `20261028090000_p2_outbound_compliance` attached `guard_outbound_verdicts` as
-- BEFORE UPDATE only, so a customer-path insert (`NumbersService` creates the row before
-- the provider call) could have arrived with a caller ID already verified. A new row from
-- the app role carries no verdict: KYC `none` or `pending`, no decision time, no caller ID.
-- Hand-written: `prisma migrate dev` will not regenerate triggers.

CREATE OR REPLACE FUNCTION app.guard_outbound_verdicts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(current_user, 'portal_admin', 'MEMBER') OR NOT pg_has_role(current_user, 'portal_app', 'MEMBER') THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'tenants' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.kyc_status NOT IN ('none', 'pending') THEN
        RAISE EXCEPTION 'kyc_status % may only be set by staff', NEW.kyc_status USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.kyc_status IS DISTINCT FROM OLD.kyc_status AND NEW.kyc_status <> 'pending' THEN
      RAISE EXCEPTION 'kyc_status % may only be set by staff', NEW.kyc_status USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.kyc_decided_at IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.kyc_decided_at IS DISTINCT FROM OLD.kyc_decided_at) THEN
      RAISE EXCEPTION 'kyc_decided_at may only be set by staff' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF TG_TABLE_NAME = 'phone_numbers' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.caller_id_verified_at IS NOT NULL OR NEW.caller_id_verified_via IS NOT NULL THEN
        RAISE EXCEPTION 'caller ID verification may only be set by staff or provisioning' USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.caller_id_verified_at IS DISTINCT FROM OLD.caller_id_verified_at
       OR NEW.caller_id_verified_via IS DISTINCT FROM OLD.caller_id_verified_via THEN
      RAISE EXCEPTION 'caller ID verification may only be set by staff or provisioning' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_guard_outbound_verdicts_insert BEFORE INSERT ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION app.guard_outbound_verdicts();
CREATE TRIGGER phone_numbers_guard_outbound_verdicts_insert BEFORE INSERT ON "phone_numbers"
  FOR EACH ROW EXECUTE FUNCTION app.guard_outbound_verdicts();
