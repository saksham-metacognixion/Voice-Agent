# ADR 0006 — Tenancy in Postgres: two roles, RLS, append-only history

- Status: accepted
- Date: 2026-09-14
- Deciders: Saksham, Prateek
- Implements: spec §6.2 (tenant context), §15 (data model), §17 (security); admin §8, §10

## Context

Every billable object belongs to a workspace, and a single Postgres database holds all of
them. The spec asks for RLS keyed by the workspace (§17) as a **second** guard behind the
auth middleware, plus an append-only `credit_ledger`, `audit_log` and `staff_audit_log`.

Three things had to be settled before any feature code could be written:

1. **What the workspace column is called.** The spec uses "workspace" in the product and
   the API (`X-Workspace-Id`, `ctx.workspaceId`) but names the table `tenants` and every
   foreign key `tenant_id` in §15.
2. **How a request tells Postgres which workspace it is in**, given a connection pool
   where one connection serves many workspaces in sequence.
3. **How "append-only" is enforced**, given that the spec asks for it twice — REVOKE and a
   trigger — and that the admin console legitimately needs a privileged connection.

## Decision

### Naming: `tenant_id` in the database, "workspace" everywhere else

The physical column is `tenant_id`, exactly as §15 spells it. The HTTP surface and every
TypeScript type say workspace. The translation happens in one place, `WorkspaceGuard`,
which reads `X-Workspace-Id` and produces `ctx = {userId, workspaceId, role}`. Below that
line it is always `tenant_id`, so an RLS policy reads
`tenant_id = app.current_tenant_id()` with nothing to mentally rename.

### Tenant context: a transaction-local GUC

`withWorkspace(workspaceId, fn)` opens a transaction, runs
`set_config('app.tenant_id', $1, true)` and passes a scoped client to `fn`.

`true` means _local to this transaction_. That is the property that makes pooling safe: the
setting dies with the transaction, so a connection handed back to the pool cannot leak
workspace A's context into workspace B's next request.

`app.current_tenant_id()` reads it with `missing_ok = true`, so an unset GUC is NULL, and
`tenant_id = NULL` matches no row. **Forgetting to set the workspace shows an empty
database, never someone else's.**

### Two roles

| Role           | Used by                                          | RLS                    |
| -------------- | ------------------------------------------------ | ---------------------- |
| `portal_app`   | the customer request path (`DATABASE_URL`)       | enforced               |
| `portal_admin` | webhooks, worker, `/admin/*`, workspace creation | crosses, by policy     |
| owner          | `prisma migrate` only (`DIRECT_DATABASE_URL`)    | not subject (no FORCE) |

Both are NOLOGIN **group** roles created by the migration; the login roles are per
environment and their passwords live in SSM, never in the repo. A policy attached
`TO portal_app` applies to any member, so `GRANT portal_app TO <login role>` is all an
environment needs.

`portal_admin` crosses workspaces through an explicit `USING (true)` policy rather than the
`BYPASSRLS` role attribute, because granting `BYPASSRLS` needs superuser and Neon gives us
no superuser. The policy is also more honest: every table states in `pg_policies` who may
cross it.

### Append-only, enforced twice

`REVOKE UPDATE, DELETE` from both app roles, **and** a `BEFORE UPDATE OR DELETE` trigger
that raises. The REVOKE stops the application; the trigger stops the migration owner, a
future BYPASSRLS role, and whoever opens psql during an incident. Reversals are new
negative rows; a balance that disagrees with Σ delta is a bug to find, not a row to edit.

Two consequences worth stating plainly:

- **A workspace with ledger history cannot be hard-deleted.** `DELETE FROM tenants`
  cascades into `credit_ledger` and the trigger refuses. The §17 delete request is
  therefore an anonymisation job, not a `DELETE` — which is what the retention rules
  wanted anyway.
- **`TRUNCATE` is deliberately not covered.** It requires table ownership, so no
  application role can reach it, but `pnpm db:reset` locally still works.

### Boot assertions

RLS only guards if the process actually connects as something RLS applies to. Point
`DATABASE_URL` at the owner and every policy silently stops applying. So `assertRlsEnforced()`
runs before the API or worker binds anything, and refuses to start unless the connection is
a `portal_app` member that is not a superuser, does not own the tables and does not bypass
RLS. `assertIssuersDiffer()` does the same job for the two Auth0 tenants (ADR 0002).

## Alternatives considered

- **Scoping every query in application code only.** Rejected: the spec asks for RLS, and
  one forgotten `where: { tenantId }` in a year of feature work is a cross-tenant leak.
- **A database or schema per workspace.** Real isolation, but migrations, connection
  budget and the admin console's cross-workspace views all get much worse at our size.
- **`BYPASSRLS` for the admin role.** Cleaner to read, but needs superuser, which Neon
  does not offer.
- **`FORCE ROW LEVEL SECURITY` on every table.** Would protect against a misconfigured
  `DATABASE_URL` at the cost of subjecting migrations to policies. `assertRlsEnforced()`
  buys the same protection without the cost.
- **Denormalising `tenant_id` onto `agent_versions` and `knowledge_sources`.** Faster
  policies, one more column to keep honest on every write. The parent lookup is a primary
  key hit; revisit only if it shows up in a profile.

## Consequences

- Feature code has exactly two ways to reach Postgres: `withWorkspace(...)` on the request
  path and `adminDb` for cross-workspace work. Anything else sees an empty database.
- New tenant-scoped tables must add their policies and grants in the same migration. The
  migration is hand-written SQL that Prisma will never regenerate; if the migration history
  is ever squashed, `20260914044100_rls_roles_append_only` has to be carried forward.
- Cross-tenant isolation and append-only history have automated coverage
  (`backend/db/test/*.e2e.test.ts`) and are part of the D14 security gate.
