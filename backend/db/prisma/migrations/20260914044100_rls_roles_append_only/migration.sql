-- ===========================================================================
-- Tenancy, least privilege and history — hand-written. Spec §17, admin §10.
--
-- Prisma does not generate any of this and `migrate dev` will not regenerate it.
-- If you ever squash migrations, carry this file forward verbatim. ADR 0006.
--
-- Three guards, in order of how much you should trust them:
--   1. the auth guard in the API   — attaches ctx = {userId, workspaceId, role}
--   2. Row Level Security below    — the second guard, not the first (§17)
--   3. REVOKE + trigger on history — even a BYPASSRLS connection cannot rewrite it
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- The current workspace, read from a transaction-local GUC.
--
-- `true` = missing_ok, so an unset GUC yields NULL rather than an error, and
-- `tenant_id = NULL` filters every row out. Forgetting to set it fails closed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

COMMENT ON FUNCTION app.current_tenant_id() IS
  'Workspace id for the current transaction. Set by @portal/db withWorkspace(); never by hand.';

-- The signed-in user, for the handful of policies where "my workspace" is not a tight
-- enough answer — editing a profile, say, where the right answer is "me".
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

COMMENT ON FUNCTION app.current_user_id() IS
  'Signed-in user for the current transaction. Set by @portal/db withWorkspace().';

-- ---------------------------------------------------------------------------
-- Two roles (§17 "least-privilege service accounts").
--
-- Group roles with NOLOGIN: the login roles are per-environment and their
-- passwords live in SSM, never here. Grant membership to create one:
--     CREATE ROLE portal_app_prod LOGIN PASSWORD '…';
--     GRANT portal_app TO portal_app_prod;
-- RLS policies are attached TO these group roles, and membership is enough for
-- a policy to apply. Locally, `pnpm db:roles` creates both login roles.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_app') THEN
    CREATE ROLE portal_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_admin') THEN
    CREATE ROLE portal_admin NOLOGIN;
  END IF;
END
$$;

COMMENT ON ROLE portal_app IS
  'Customer request path. RLS-enforced; every query runs inside withWorkspace().';
COMMENT ON ROLE portal_admin IS
  'Webhooks, worker, /admin/*. Crosses workspaces by policy; still cannot rewrite history.';

GRANT USAGE ON SCHEMA public, app TO portal_app, portal_admin;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(), app.current_user_id()
  TO portal_app, portal_admin;

-- ---------------------------------------------------------------------------
-- The history tables: append-only, enforced twice.
--
-- REVOKE stops the app roles. The trigger stops everyone else, including the
-- migration owner and any future BYPASSRLS role — reversals are new rows, and a
-- balance that disagrees with Σ delta is a bug to find, never a row to edit.
-- TRUNCATE is deliberately not covered: it needs table ownership, so only a
-- local reset (`pnpm db:reset`) can use it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.reject_history_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION
    'append_only_violation: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING
      ERRCODE = '42501',
      HINT = 'History is append-only (§17). Write a compensating row instead.';
END
$$;

CREATE TRIGGER credit_ledger_append_only
  BEFORE UPDATE OR DELETE ON "credit_ledger"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

CREATE TRIGGER staff_audit_log_append_only
  BEFORE UPDATE OR DELETE ON "staff_audit_log"
  FOR EACH ROW EXECUTE FUNCTION app.reject_history_mutation();

-- ---------------------------------------------------------------------------
-- Grants. Default deny: nothing is granted to portal_app that is not listed here.
-- ---------------------------------------------------------------------------

-- Workspace-scoped data the customer portal reads and writes.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  "memberships", "invites", "notification_settings",
  "agents", "agent_versions", "knowledge_sources",
  "phone_plans", "phone_numbers", "calls",
  "credit_lots", "purchases", "jobs", "alerts",
  "support_tickets", "ticket_messages"
  TO portal_app;

-- A workspace is created and deleted on the admin connection (§13.2); the
-- portal only reads its own row and edits settings.
GRANT SELECT, UPDATE ON TABLE "tenants" TO portal_app;

-- A user edits their own profile. Which rows they can see is the RLS policy's job.
GRANT SELECT, UPDATE ON TABLE "users" TO portal_app;

-- History: insert and read, never change.
GRANT SELECT, INSERT ON TABLE "credit_ledger", "audit_log" TO portal_app;

-- Versioned configuration is read through GET /pricing and GET /flags (§13.12).
GRANT SELECT ON TABLE
  "templates", "packs", "voices",
  "pricing_configs", "agent_stack_configs",
  "feature_flags", "kill_switches", "announcements"
  TO portal_app;

-- support_tickets.id is a serial.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO portal_app, portal_admin;

-- The admin role reaches everything, then loses the right to rewrite history.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO portal_admin;

REVOKE UPDATE, DELETE ON TABLE "credit_ledger", "audit_log", "staff_audit_log"
  FROM portal_app, portal_admin;

-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- Every table below gets two policies:
--   <table>_tenant_isolation  TO portal_app    — the workspace predicate
--   <table>_admin_all         TO portal_admin  — crosses workspaces deliberately
-- A role that matches neither sees an empty table, because RLS denies by default.
-- The migration owner is not subject to RLS (no FORCE), which is why the API
-- asserts at boot that its runtime connection is a portal_app member — see
-- assertRlsEnforced() in @portal/db.
-- ---------------------------------------------------------------------------

-- Tables carrying tenant_id directly.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships', 'invites', 'audit_log', 'notification_settings',
    'agents', 'phone_plans', 'phone_numbers', 'calls',
    'credit_lots', 'credit_ledger', 'purchases', 'jobs', 'alerts',
    'support_tickets'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO portal_app
         USING (tenant_id = app.current_tenant_id())
         WITH CHECK (tenant_id = app.current_tenant_id())',
      t || '_tenant_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO portal_admin USING (true) WITH CHECK (true)',
      t || '_admin_all', t);
  END LOOP;
END
$$;

-- Staff-only tables. portal_app holds no grant on any of them; RLS is the second
-- lock, so a grant added by mistake still leaks nothing.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'custom_deals', 'tenant_overrides', 'credit_adjustments', 'customer_notes',
    'customer_flags', 'impersonation_sessions', 'fraud_reviews', 'data_requests',
    'staff_audit_log', 'staff_users', 'staff_role_limits', 'refunds',
    'pricing_drafts', 'stripe_price_map', 'promo_codes', 'retell_cost_inputs',
    'canned_responses', 'email_templates', 'blocklists', 'webhook_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO portal_admin USING (true) WITH CHECK (true)',
      t || '_admin_all', t);
  END LOOP;
END
$$;

-- The workspace's own row.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenants_tenant_isolation ON "tenants" FOR ALL TO portal_app
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());
CREATE POLICY tenants_admin_all ON "tenants" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);

-- Users need two policies, because reading and writing have different answers.
--
-- Read: anyone sharing a workspace with you, which is what GET /members needs, and
-- nothing beyond it — workspace A cannot enumerate workspace B's people.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_read_co_members ON "users" FOR SELECT TO portal_app
  USING (EXISTS (
    SELECT 1 FROM "memberships" m
     WHERE m.user_id = users.id AND m.tenant_id = app.current_tenant_id()));

-- Write: yourself only. Sharing a workspace with someone is not a reason to be able to
-- rewrite their name or email, and a `where` clause is too easy to leave off.
CREATE POLICY users_update_self ON "users" FOR UPDATE TO portal_app
  USING (id = app.current_user_id())
  WITH CHECK (id = app.current_user_id());

CREATE POLICY users_admin_all ON "users" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);

-- Children of agents. Denormalising tenant_id onto them would be one more column
-- to keep honest; agents.id is the primary key, so the subquery is an index hit.
ALTER TABLE "agent_versions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_versions_tenant_isolation ON "agent_versions" FOR ALL TO portal_app
  USING (EXISTS (
    SELECT 1 FROM "agents" a
     WHERE a.id = agent_versions.agent_id AND a.tenant_id = app.current_tenant_id()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "agents" a
     WHERE a.id = agent_versions.agent_id AND a.tenant_id = app.current_tenant_id()));
CREATE POLICY agent_versions_admin_all ON "agent_versions" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);

ALTER TABLE "knowledge_sources" ENABLE ROW LEVEL SECURITY;
CREATE POLICY knowledge_sources_tenant_isolation ON "knowledge_sources" FOR ALL TO portal_app
  USING (EXISTS (
    SELECT 1 FROM "agents" a
     WHERE a.id = knowledge_sources.agent_id AND a.tenant_id = app.current_tenant_id()))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "agents" a
     WHERE a.id = knowledge_sources.agent_id AND a.tenant_id = app.current_tenant_id()));
CREATE POLICY knowledge_sources_admin_all ON "knowledge_sources" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);

-- Ticket messages: the customer's own workspace, and never an internal note
-- (admin §10 — staff-only text is hidden by the database, not by the UI).
ALTER TABLE "ticket_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_messages_tenant_isolation ON "ticket_messages" FOR ALL TO portal_app
  USING (is_internal = false AND EXISTS (
    SELECT 1 FROM "support_tickets" t
     WHERE t.id = ticket_messages.ticket_id AND t.tenant_id = app.current_tenant_id()))
  WITH CHECK (is_internal = false AND EXISTS (
    SELECT 1 FROM "support_tickets" t
     WHERE t.id = ticket_messages.ticket_id AND t.tenant_id = app.current_tenant_id()));
CREATE POLICY ticket_messages_admin_all ON "ticket_messages" FOR ALL TO portal_admin
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Indexes supporting the policy predicates and the FIFO lot scan (§5.4).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "memberships_tenant_id_user_id_idx"
  ON "memberships" ("tenant_id", "user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_call_debit_once_idx"
  ON "credit_ledger" ("ref_id")
  WHERE reason = 'call';

COMMENT ON INDEX "credit_ledger_call_debit_once_idx" IS
  'One debit per call, forever (§14.2). A replayed call_ended hits this and no-ops.';

CREATE INDEX IF NOT EXISTS "credit_lots_fifo_idx"
  ON "credit_lots" ("tenant_id", "expires_at")
  WHERE credits_remaining > 0;

-- notification_settings.user_id IS NULL means "the workspace default". Postgres treats
-- NULLs as distinct in a unique index, so the constraint Prisma generated would happily
-- allow a second default row. This is the one that actually holds.
CREATE UNIQUE INDEX IF NOT EXISTS "notification_settings_workspace_default_idx"
  ON "notification_settings" ("tenant_id")
  WHERE user_id IS NULL;
