-- ADR 0011 §7 (review, 24 Sep 2026): `call-recovery` remembers what it has asked the platform.
-- A row the platform cannot answer for — a call it never created, a short call it never
-- analysed — was re-asked on every 5-minute tick for the whole window, and newest-first
-- with a batch of 100 let such rows starve a call whose webhook was actually lost. Now a
-- row is asked once per recheck interval, rows never asked come first, and an unanalysed
-- row is given up after a few answers.
ALTER TABLE "calls"
  ADD COLUMN "recovery_checked_at" TIMESTAMP(3),
  ADD COLUMN "recovery_checks" INTEGER NOT NULL DEFAULT 0;
