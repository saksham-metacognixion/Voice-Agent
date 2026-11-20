-- Admin §9 `POST /admin/calls/:id/flag` (QA, 28 Oct 2026): staff mark a call for a second
-- look — a quality complaint, a suspected abuse pattern — with a note, and SA8 filters on
-- it. Who flagged it is the staff id; the full history is `staff_audit_log` (`call.flagged`
-- / `call.unflagged`), so the row holds only the current state.
ALTER TABLE "calls"
  ADD COLUMN "flagged_at" TIMESTAMP(3),
  ADD COLUMN "flagged_by" UUID,
  ADD COLUMN "flag_note" TEXT;

-- SA8 "Flagged" lists only these, newest first; nearly every call is unflagged.
CREATE INDEX "calls_flagged_at_idx" ON "calls" ("flagged_at" DESC) WHERE "flagged_at" IS NOT NULL;
