-- §6.4 "onboarding not dismissed": the wizard's "Save and exit" (§7.3) records it here,
-- and the dashboard opens with a "Finish setup" card instead of bouncing to the step
-- (ADR 0039). Additive only (ADR 0034).
ALTER TABLE "tenants" ADD COLUMN "onboarding_dismissed_at" TIMESTAMP(3);
