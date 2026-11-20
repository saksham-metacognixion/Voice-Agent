# ADR 0015 — The domain, and the AWS backend stack as one CloudFormation template

- Status: accepted
- Date: 2026-09-22
- Deciders: Saksham (domain: Prateek)
- Scope: §20 item 1 (working name and domain), §13.12 (environments), §17 (secrets),
  ADR 0004 (the EC2 stack), ADR 0014 §9 (compose stack, CI deploy).

## Context

D7 built the compose stack, the deploy script and the CI job, but nothing to deploy onto: no
instance, Elastic IP, IAM, SSM parameters or KMS key existed, and there was no domain for
Caddy to issue a certificate for. On 22 Sep 2026 the domain **oraly.ai** was registered at
Namecheap. The AWS account (878013573203) is shared with other company projects, and the only
credentials on the development machine are another project's deploy user — enough to list
instances, refused on everything the backend needs (`ec2:CreateSecurityGroup`,
`ec2:AllocateAddress`, `iam:*`, `ssm:*`, `kms:*`). ADR 0004 described the resources as a
console checklist; a checklist clicked through by whoever has rights that day is how a
staging box ends up with SSH open and a role nobody can name.

## Decision

1. **Hostnames.** `api.oraly.ai`, `app.oraly.ai`, `admin.oraly.ai` for production; the same
   with a `-staging` suffix for staging (`api-staging.oraly.ai`, …). DNS stays on Namecheap
   BasicDNS for MVP: three A/CNAME records and the ACM validation CNAMEs are not worth a
   Route 53 zone and another IAM grant. `PORTAL_URL` on staging is `https://app-staging.oraly.ai`
   from day one, even before the portal is deployed, because `deploy.sh` refuses localhost.
2. **One template per environment stack**, `infra/aws/backend-stack.yaml`: security group
   (80/443 only), instance role (Session Manager, `GetParametersByPath` on its own SSM path,
   `GenerateDataKey`/`Decrypt` on the SIP key), the instance (Ubuntu 24.04 by the canonical
   SSM public parameter, IMDSv2 required, encrypted root, Docker installed by user data),
   Elastic IP, the KMS key, the CI user with `ssm:SendCommand` on that one instance, and an
   operator policy for the developer. **No SSH key and no port 22**: the shell is Session
   Manager, the deploy is Run Command. Deploying the stack is the one step that needs an
   account administrator; everything after it runs under the operator policy.
3. **Secrets never enter the template or the repo.** They live in a `KEY=VALUE` file outside
   the working tree (mode 600) and reach SSM Parameter Store through
   `infra/scripts/ssm-put-env.sh`, which validates the file (no empty values, no localhost
   `PORTAL_URL`, https `API_PUBLIC_URL`, not inside the repo) and prints key names and
   lengths only. `deploy.sh` reads them back on the box. Neon login roles and their pooled
   URLs come from `infra/scripts/db-env-roles.sh` into the same file.
4. **The private repository is reached with one read-only classic PAT** (`repo` +
   `read:packages`) stored on the instance by the bootstrap, for both `git fetch` and
   `docker compose pull`. Not in SSM: `deploy.sh` writes every parameter into `.env`, and a
   registry token has no business in the container environment.
5. **`t3.small` for staging keeps its 2 GB usable with 2 GB of swap.** api, worker, redis,
   caddy and the OS sit around 1.3 GB steady; the worker's 1 GB compose cap means a spike
   (knowledge ingestion, exports) kills the worker rather than the box, and the API's §13.9
   path survives. Swap at `vm.swappiness=10` is insurance for that spike, not working
   memory: swap in use is the signal to move the environment to `t3.medium`, which is what
   prod gets anyway (ADR 0004).
6. **Region `ca-central-1`** for the stack (where the account already runs) and Neon in
   `aws-us-east-1` (no Canadian Neon region). The §13.9 hot path is Redis-only, so the
   database hop is off the latency budget.
7. **Image name is `ghcr.io/metacognixion-labs/voice-agent-backend`**, lowercased in CI from
   the repository owner; the compose file and `deploy.sh` default to the same string and CI
   passes it explicitly.

## Alternatives considered

**Console checklist (ADR 0004 as written).** Faster the first time, invisible afterwards.
The instance role and the CI user's scope are exactly the things that drift.

**Terraform / CDK.** A second toolchain plus a state backend to host and protect, for eight
resources that change twice a year. CloudFormation is already in the account, needs no
state file, and the console shows the stack.

**Route 53 for oraly.ai.** Cleaner API, and the frontend's ACM validation would be one
resource. It costs a hosted zone, a nameserver change and another IAM grant for three
records. Revisit when the frontend stacks (D8) want to manage their own records.

**A Neon region closer to the box.** None exists in Canada; `us-east-1` is the nearest and
the only path that reads Postgres per request is the customer API, not the call path.

## Consequences

- `docs/runbooks/staging.md` is now numbered by who does what: step 1 an administrator, 2–7
  the developer. Until step 1 runs, nothing is deployed — the blocker is access, not code.
- `deploy.sh` needs an IMDSv2 token for the region (fixed with this ADR); a box that is not
  the template's still works if `AWS_REGION` is set.
- The CI user can deploy to exactly one instance. A second environment is a second stack
  and a second GitHub environment, not a wider policy.
- Rotating the GitHub PAT or the CI access key is a manual step; both are named in the
  runbook's step 5 and 7. Nothing else holds a long-lived credential except SSM.
- §20 item 1 is closed. Auth0 API identifiers stay `https://api.metacognixion.com` and
  `https://admin-api.metacognixion.com` in the dev tenants — they are identifiers, not URLs,
  and cannot be edited; staging and prod tenants may use `https://api.oraly.ai`.
