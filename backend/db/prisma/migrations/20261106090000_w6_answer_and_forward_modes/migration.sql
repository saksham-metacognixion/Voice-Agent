-- §8 W6 "Answer calls" (ADR 0040): the spec's "Only outside business hours" and "Only when
-- I don't answer" join the hours modes; Option B's forward mode is kept on the plan and
-- copied to the number. Additive only (ADR 0034).
ALTER TYPE "hours_mode" ADD VALUE IF NOT EXISTS 'outside_hours';
ALTER TYPE "hours_mode" ADD VALUE IF NOT EXISTS 'unanswered';
ALTER TABLE "phone_plans" ADD COLUMN "forward_mode" TEXT;
ALTER TABLE "phone_numbers" ADD COLUMN "forward_mode" TEXT;
