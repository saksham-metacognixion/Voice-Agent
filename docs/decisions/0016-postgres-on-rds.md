# ADR 0016 — Postgres on Amazon RDS, private, in the environment's own stack

- Status: accepted
- Date: 2026-09-22
- Deciders: Saksham
- Supersedes: the Database row of [ADR 0001](0001-tech-stack.md) and the "RDS Postgres instead
  of Neon" alternative in [ADR 0004](0004-backend-hosting-aws-ec2.md)
- Scope: §15 (data model), §17 (PITR, least privilege), ADR 0006 (two roles, RLS),
  ADR 0015 (the environment stack)

## Context

ADR 0001 put Postgres on Neon and ADR 0004 re-examined it, keeping Neon for cost and branching
and noting "revisit when the org consolidates on AWS". On 22 Sep 2026, while bringing staging
up, there was no Neon account and the org already runs this account (`667723749107`,
`ca-central-1`) with CloudFormation. Creating a Neon account would have added a vendor, a
credential to rotate and a database on the public internet, to save roughly $15 a month.

The question that decides it is not cost. **ADR 0006 gives `portal_admin` BYPASSRLS-like
reach**, and on RDS the master user is `rds_superuser`, not a superuser, so it cannot set the
`BYPASSRLS` role attribute. If the schema needed that attribute, RDS would be impossible
without rewriting the tenancy model. Checked against
`20260914044100_rls_roles_append_only/migration.sql` before deciding:

| Needs superuser?           | In the schema?                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CREATE ROLE … BYPASSRLS`  | **No.** Both roles are `NOLOGIN` with no attributes; `portal_admin` crosses workspaces through `CREATE POLICY … TO portal_admin USING (true) WITH CHECK (true)` on every table |
| `CREATE EXTENSION`         | **No.** The schema uses none                                                                                                                                                   |
| `FORCE ROW LEVEL SECURITY` | **No.** The owner is used for migrations only, and `assertRlsEnforced()` refuses to boot on an owner or BYPASSRLS `DATABASE_URL`                                               |

Everything else the migration does — `CREATE SCHEMA`, sql/plpgsql functions, triggers,
`CREATE ROLE … NOLOGIN`, `GRANT`/`REVOKE` — is available to the RDS master user.

## Decision

**Postgres runs on Amazon RDS, one `db.t4g.micro` instance per environment, inside the
environment's CloudFormation stack** (`infra/aws/backend-stack.yaml`, ADR 0015).

| Concern          | Choice                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine           | PostgreSQL 16, matching `infra/docker-compose.yml` and CI                                                                                                                           |
| Size             | `db.t4g.micro` staging, `db.t4g.small` or larger for prod. 20 GB gp3, autoscaling to 100 (500 in prod)                                                                              |
| Reachability     | **`PubliclyAccessible: false`.** A dedicated security group accepts 5432 from the backend instance's security group and from nothing else                                           |
| Developer access | Session Manager port forwarding to the instance (`DbTunnelCommand` in the stack outputs). There is no public address to firewall, and every session is audited                      |
| Master password  | `ManageMasterUserPassword: true` — generated into Secrets Manager. Neither the template nor SSM holds it. It creates the two login roles and runs migrations; the app never uses it |
| App credentials  | Unchanged: `portal_app_<env>` and `portal_admin_<env>` from `infra/scripts/db-env-roles.sh`, their URLs in SSM                                                                      |
| Backups          | `BackupRetentionPeriod: 7`, which is the §17 point-in-time recovery window. RDS allows 35 if we want more                                                                           |
| Deletion         | `DeletionPolicy: Snapshot` and `UpdateReplacePolicy: Snapshot`, so tearing the stack down keeps the data. `DeletionProtection` on in prod                                           |
| Multi-AZ         | Off for staging, a parameter for prod (it doubles the instance cost)                                                                                                                |

No connection pooler. Prisma pools per process, `num_cpus × 2 + 1`, so the API and the worker
hold about ten connections between them against this class's ~110 — RDS Proxy would cost more
than the database. The `-pooler` hostname rewriting in `db-env-roles.sh` stays for Neon and is
a no-op on an RDS host.

## Alternatives considered

**Neon** (ADR 0001, ADR 0004). Free at staging size, real branching, and a managed pooler.
Set aside because the account did not exist, the endpoint is public, and nothing in the repo
uses branching. Cost is close once Neon is paid.

**RDS, publicly accessible, security group limited to the developer's IP.** Keeps `psql` and
`pnpm db:deploy` working with no tunnel. Rejected: a home or café address changes and the
group drifts open, and "publicly accessible database" is a finding in any review. Port
forwarding is one command and needs no firewall edit.

**Aurora Serverless v2.** Scales to near zero and is the better answer at scale. Its floor is
0.5 ACU billed continuously, which is more than this instance, for a staging box that serves
one developer.

**Postgres in the compose stack on the instance.** Cheapest and lowest latency. Rejected: no
point-in-time recovery, the §17 requirement, and one EBS failure would take the ledger with it.

## Consequences

- Migrations and `db-env-roles.sh` run through the SSM tunnel, not against a public host. The
  script takes `DB_PUBLIC_HOST` so the URLs it writes name the address the **server** uses
  while it connects over the tunnel itself.
- The operator policy gains `secretsmanager:GetSecretValue` on the master secret and the
  `AWS-StartPortForwardingSessionToRemoteHost` document. The instance role gains nothing: the
  app authenticates with a password from SSM, not with IAM.
- One stack per environment now carries the data as well as the compute. `DeletionPolicy:
Snapshot` is what makes that safe; do not remove it.
- The database is in the same VPC and availability zone family as the instance, so the
  round trip is a fraction of a millisecond. The §13.9 inbound path still never reads it.
- Restoring a snapshot creates a new endpoint, so recovery means a stack parameter change or a
  manual `DATABASE_URL` update in SSM, then a redeploy. Write the runbook entry when first tested.
