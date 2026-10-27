-- D17 (P2): the website widget (§11.5) and the forwarding test (D4, spec p. 37).

-- 1. The widget, per agent. The key is public (it sits in the customer's page source), so
--    it is an identifier, not a credential: what lets a call through is the agent being
--    live and the wallet covering it. Unique, so the public route resolves one agent.
ALTER TABLE "agents"
  ADD COLUMN "widget_key" TEXT,
  ADD COLUMN "widget_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "widget_origins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE UNIQUE INDEX "agents_widget_key_key" ON "agents" ("widget_key");

-- 2. The last "Test forwarding" of an Option B number: status, times, how the call showed
--    up. Outcome words only — never a call id or a platform payload.
ALTER TABLE "phone_numbers"
  ADD COLUMN "forwarding_test_json" JSONB;
