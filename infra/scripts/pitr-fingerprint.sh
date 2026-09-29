#!/usr/bin/env bash
# D14 — RDS point-in-time restore drill (§17 "Postgres PITR 7 days", ADR 0016).
# Procedure: docs/runbooks/pitr-drill.md.
#
#   infra/scripts/pitr-fingerprint.sh <database-url> <cutoff ISO-8601> > file.txt
#
# Prints a canonical, sortable description of everything that existed at <cutoff>, so the
# live database and a copy restored to <cutoff> can be compared with `diff`:
#
#   * counts of rows created at or before the cutoff, for the tables whose rows are never
#     deleted (the append-only ledgers and logs, billing history, soft-deleted agents);
#   * Σ credit_ledger.delta per workspace at the cutoff — the balance every customer had;
#   * the structure a restore must bring back with the data: applied migrations, RLS
#     enabled per table, the policy count, the append-only / immutability triggers and the
#     two application roles.
#
# Rows committed within a second or two of the cutoff can straddle it (created_at is the
# statement's start, visibility is the commit). Pick a quiet minute; a one-row difference
# in `calls` or `jobs`-adjacent tables at that edge is not data loss.
#
# Read-only. Needs psql (brew install libpq).
set -euo pipefail

URL="${1:?database url (through the SSM tunnel)}"
CUTOFF="${2:?cutoff, ISO-8601 with zone, e.g. 2026-10-01T09:30:00Z}"

psql "$URL" -X -v ON_ERROR_STOP=1 -v cutoff="$CUTOFF" -At -F ' ' <<'SQL'
\set QUIET on
-- Never deleted by the application (§15, ADR 0006/0010/0012): a restore to the cutoff must
-- hold exactly these rows.
SELECT 'rows', t, n FROM (
  SELECT 'credit_ledger' AS t, count(*) AS n FROM credit_ledger WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'credit_lots', count(*) FROM credit_lots WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'audit_log', count(*) FROM audit_log WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'staff_audit_log', count(*) FROM staff_audit_log WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'tenants', count(*) FROM tenants WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'users', count(*) FROM users WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'agents', count(*) FROM agents WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'agent_versions', count(*) FROM agent_versions WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'calls', count(*) FROM calls WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'purchases', count(*) FROM purchases WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'phone_numbers', count(*) FROM phone_numbers WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'refunds', count(*) FROM refunds WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'credit_adjustments', count(*) FROM credit_adjustments WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'support_tickets', count(*) FROM support_tickets WHERE created_at <= :'cutoff'::timestamptz
  UNION ALL SELECT 'ticket_messages', count(*) FROM ticket_messages WHERE created_at <= :'cutoff'::timestamptz
) c ORDER BY t;

-- Every workspace's balance at the cutoff, and the rows behind it.
SELECT 'balance', tenant_id, count(*), sum(delta)
FROM credit_ledger WHERE created_at <= :'cutoff'::timestamptz
GROUP BY tenant_id ORDER BY tenant_id;

-- Relationships a restore could only break by being partial: every ledger row, call and
-- agent points at a workspace that exists, every membership at a user that exists.
SELECT 'orphans', 'credit_ledger', count(*) FROM credit_ledger l WHERE l.created_at <= :'cutoff'::timestamptz AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = l.tenant_id);
SELECT 'orphans', 'calls', count(*) FROM calls c WHERE c.created_at <= :'cutoff'::timestamptz AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = c.tenant_id);
SELECT 'orphans', 'agents', count(*) FROM agents a WHERE a.created_at <= :'cutoff'::timestamptz AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = a.tenant_id);
SELECT 'orphans', 'memberships', count(*) FROM memberships m WHERE m.created_at <= :'cutoff'::timestamptz AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id);

-- Structure. Migrations applied before the cutoff (a later deploy's are legitimately absent).
SELECT 'migration', migration_name FROM _prisma_migrations
WHERE finished_at IS NOT NULL AND finished_at <= :'cutoff'::timestamptz ORDER BY migration_name;
SELECT 'rls', relname, relrowsecurity, relforcerowsecurity FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity ORDER BY relname;
SELECT 'policies', count(*) FROM pg_policies WHERE schemaname = 'public';
SELECT 'trigger', tgrelid::regclass::text, tgname FROM pg_trigger
WHERE NOT tgisinternal AND tgname IN ('credit_ledger_append_only', 'audit_log_append_only', 'staff_audit_log_append_only', 'agent_versions_immutable')
ORDER BY tgname;
SELECT 'role', rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('portal_app', 'portal_admin') ORDER BY rolname;
SQL
