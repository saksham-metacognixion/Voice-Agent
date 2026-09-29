-- D13 review (28 Sep 2026): a refund retried after a failure needs a fresh Stripe
-- idempotency key — Stripe answers a repeat of the old key with the stored error for 24 h,
-- so "try again from the same dialog" could never succeed. The key is `refund-<id>-r<n>`.
ALTER TABLE "refunds" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
