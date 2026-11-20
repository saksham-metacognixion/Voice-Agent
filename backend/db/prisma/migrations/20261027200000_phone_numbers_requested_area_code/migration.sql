-- QA-076: the area code the customer asked for, beside the one bought. `area_code` is
-- overwritten with the code the platform actually sold (purchase-attempts.ts walks the
-- overlays and then any local number when the requested code has no stock), so W7/live and
-- D4 could not say "No 647 numbers were available; we chose 236". Written once, at
-- creation, never by provisioning. Table-level grants cover the new column.
ALTER TABLE "phone_numbers" ADD COLUMN "requested_area_code" TEXT;

-- Backfill: the plan still holds what W6 asked for. A number without a plan (D4 "Add a
-- number") has only the bought code left; it reads as asked-for = bought, so no note.
UPDATE "phone_numbers" n
   SET "requested_area_code" = p."area_code"
  FROM "phone_plans" p
 WHERE n."plan_id" = p."id"
   AND n."type" <> 'custom_sip';
UPDATE "phone_numbers"
   SET "requested_area_code" = "area_code"
 WHERE "requested_area_code" IS NULL
   AND "plan_id" IS NULL
   AND "type" <> 'custom_sip';
