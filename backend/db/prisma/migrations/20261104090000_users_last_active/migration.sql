-- §10 D6 Team "last active" (spec member table: name, email, role, last active, MFA ✓).
-- Additive only (ADR 0034). Written by AuthGuard at most every 5 minutes per person.
ALTER TABLE "users" ADD COLUMN "last_active_at" TIMESTAMP(3);
