-- QA-104 (ORL-NUM-644): a staff pause of a number is its own state. Additive only (ADR 0034).
-- Until now staff paused a number by writing `status = 'paused'` + `paused_at`, the same two
-- columns the customer's "Answer calls on this number" switch writes, so the customer could
-- switch it back on.
ALTER TABLE "phone_numbers" ADD COLUMN "staff_paused_at" TIMESTAMP(3);
ALTER TABLE "phone_numbers" ADD COLUMN "staff_paused_reason" TEXT;
ALTER TABLE "phone_numbers" ADD COLUMN "staff_paused_ticket_id" INTEGER;
ALTER TABLE "phone_numbers" ADD COLUMN "staff_paused_by" TEXT;

-- Numbers staff paused before this migration: the latest console audit row for the number is
-- a `number.paused` by staff. Move them to the new columns and give the customer's own switch
-- back its default (on); the old pause could not be told apart from the customer's.
WITH latest AS (
  SELECT DISTINCT ON (target_id) target_id, action, meta_json, created_at
  FROM "audit_log"
  WHERE target_type = 'number' AND action IN ('number.paused', 'number.resumed')
  ORDER BY target_id, created_at DESC
)
UPDATE "phone_numbers" p
SET "staff_paused_at" = COALESCE(p."paused_at", latest.created_at),
    "staff_paused_reason" = latest.meta_json ->> 'reason_code',
    "status" = 'active',
    "paused_at" = NULL
FROM latest
WHERE p.id::text = latest.target_id
  AND latest.action = 'number.paused'
  AND latest.meta_json ->> 'by' = 'staff'
  AND p."status" = 'paused';

-- Defence in depth, like `guard_outbound_verdicts`: the customer's database role cannot write
-- the staff pause on INSERT or UPDATE, whatever a service does.
CREATE OR REPLACE FUNCTION app.guard_number_staff_pause() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(current_user, 'portal_admin', 'MEMBER') OR NOT pg_has_role(current_user, 'portal_app', 'MEMBER') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.staff_paused_at IS NOT NULL OR NEW.staff_paused_reason IS NOT NULL
       OR NEW.staff_paused_ticket_id IS NOT NULL OR NEW.staff_paused_by IS NOT NULL THEN
      RAISE EXCEPTION 'the staff pause may only be set by staff' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.staff_paused_at IS DISTINCT FROM OLD.staff_paused_at
     OR NEW.staff_paused_reason IS DISTINCT FROM OLD.staff_paused_reason
     OR NEW.staff_paused_ticket_id IS DISTINCT FROM OLD.staff_paused_ticket_id
     OR NEW.staff_paused_by IS DISTINCT FROM OLD.staff_paused_by THEN
    RAISE EXCEPTION 'the staff pause may only be set by staff' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER phone_numbers_guard_staff_pause BEFORE INSERT OR UPDATE ON "phone_numbers"
  FOR EACH ROW EXECUTE FUNCTION app.guard_number_staff_pause();
