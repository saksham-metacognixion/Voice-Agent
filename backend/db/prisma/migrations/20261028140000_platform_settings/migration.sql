-- Admin §9 `PUT /admin/settings` and `PUT /admin/concurrency/allowance` (QA, 28 Oct 2026):
-- the platform knobs that were environment variables — the voice platform's concurrent-call
-- allowance, the concurrency alert threshold, the reconciliation drift threshold — set from
-- the console without a redeploy. One row per key; a key with no row falls back to its
-- environment variable, then to the compiled default. History is `staff_audit_log`.
CREATE TABLE "platform_settings" (
  "key"        TEXT         NOT NULL,
  "value"      JSONB        NOT NULL,
  "updated_by" UUID,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

-- No tenant_id: nothing for portal_app to see. Deny by default (RLS on, no app policy).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "platform_settings" TO portal_admin;
ALTER TABLE "platform_settings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY platform_settings_admin_all ON "platform_settings" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);
