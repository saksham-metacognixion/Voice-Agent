-- QA-105 (ORL-NUM-631/632): a released number can be connected again.
--
-- `phone_numbers.e164` was unique across every row, and a release keeps the row (calls and
-- rental ledger rows reference it) with its e164. So a released SIP line could never be
-- imported again — by its own workspace or any other — and a bought number the carrier
-- later resold would have failed at provisioning.
--
-- Uniqueness now covers the rows that hold a number: every status except `released`. Two
-- live rows still cannot share a number; a released row is history and holds nothing.
-- A row never leaves `released` (release is final, provisioning refuses it), so no row can
-- re-enter the index and collide.
--
-- Safe on existing data: the old index already made every e164 unique, so the partial one
-- builds on any table the old one allowed. Rollback-safe (ADR 0034): code before this
-- migration still writes rows that satisfy the partial index. The new index is created
-- before the old one is dropped, so no window exists without either.

CREATE UNIQUE INDEX IF NOT EXISTS "phone_numbers_e164_held_key"
  ON "phone_numbers" ("e164")
  WHERE "status" <> 'released';

COMMENT ON INDEX "phone_numbers_e164_held_key" IS
  'QA-105: one row holds a number at a time; released rows keep their e164 as history.';

DROP INDEX IF EXISTS "phone_numbers_e164_key";

-- Lookups by number that must also see released rows (the call handlers' fallback, staff search).
CREATE INDEX IF NOT EXISTS "phone_numbers_e164_idx" ON "phone_numbers" ("e164");
