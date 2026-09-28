-- D12 QA (28 Sep 2026): SA3 "Force logout" must end sessions the API already accepts.
-- Revoking at the identity provider stops new tokens; an access token already in a browser
-- stays valid for its lifetime (an hour). AuthGuard refuses any token issued at or before
-- this instant, so a force logout — or a lock — takes effect on the next request.
ALTER TABLE "users" ADD COLUMN "sessions_revoked_at" TIMESTAMP(3);
