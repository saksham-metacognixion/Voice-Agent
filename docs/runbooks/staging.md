# Staging runbook — the EC2 backend stack (ADR 0004, ADR 0014, ADR 0015)

What runs, how it gets there, and how to check it. The domain is **oraly.ai** (Namecheap,
BasicDNS — decided 22 Sep 2026, ADR 0015). Staging hosts carry a `-staging` suffix:

| Host                                             | Points at                     | Environment | Since  |
| ------------------------------------------------ | ----------------------------- | ----------- | ------ |
| `api-staging.oraly.ai`                           | EC2 Elastic IP (this runbook) | staging     | D7     |
| `app-staging.oraly.ai`                           | CloudFront (portal, ADR 0008) | staging     | D8     |
| `admin-staging.oraly.ai`                         | CloudFront (admin, ADR 0008)  | staging     | D12    |
| `api.oraly.ai`, `app.oraly.ai`, `admin.oraly.ai` | the same, prod                | prod        | launch |

Everything the backend needs on AWS is one CloudFormation template,
`infra/aws/backend-stack.yaml`, deployed once per environment. **The record of the real staging
run — what exists, what broke and why — is [staging-deploy-log.md](staging-deploy-log.md); keep
it current as steps complete.** Staging is live since 23 Sep 2026, backend and portal; the
order it was actually built in, with the real values and the traps, is
[staging-deployment-steps.md](staging-deployment-steps.md). "Where we stand" at the end is the
22 Sep snapshot.

## What runs

```
 Retell / Stripe / Auth0 / browsers ──HTTPS──▶ api-staging.oraly.ai  (Elastic IP)
                                                │  caddy      TLS (Let's Encrypt), :80/:443, SSE passthrough
                                                ▼
                                              api           node dist/main.js     uncapped   (§13.9 hot path)
                                              worker        node dist/worker.js   1 CPU, 1 GB (BullMQ + §13.11 schedules)
                                              redis         redis:7, AOF, compose-internal
                                              RDS Postgres (private, same VPC, reachable only from this box)
```

Files: `infra/aws/backend-stack.yaml`, `infra/docker-compose.prod.yml`, `infra/caddy/Caddyfile`,
`infra/scripts/deploy.sh`, `infra/scripts/ssm-put-env.sh`, `infra/scripts/db-env-roles.sh`,
`infra/scripts/instance-bootstrap.sh`, `infra/Dockerfile`, `.github/workflows/ci.yml`.

## One-time setup (per environment)

Steps 1 and 5 need an AWS account administrator; the rest is the developer with the operator
policy the stack creates. Order matters: the Elastic IP exists after step 1, DNS needs it,
Caddy's certificate needs DNS, and the webhook URLs need the certificate.

### 0. Permissions for the developer (administrator, once per account)

The stack creates an instance role, a CI user and two managed policies, so whoever deploys it
needs IAM rights that `PowerUserAccess` deliberately does not include. There are two postures;
pick one.

**Simple** — one policy. Create a customer managed policy named `voice-agent-deploy-iam` from
`infra/aws/operator-bootstrap-policy.json` and attach it to the developer's IAM user.

**Strict** — two policies, for an account that should not trust the deployer with an escalation
path. Create `voice-agent-boundary` from `infra/aws/voice-agent-boundary-policy.json` **first**,
then `voice-agent-deploy-iam` from `infra/aws/operator-bootstrap-policy-strict.json`, and attach
the second to the developer. Deploy the stack with `PermissionsBoundaryArn` set to the
boundary's ARN, or every identity it creates is refused.

Either way, delete the `Comment` key before pasting; IAM rejects unknown top-level keys. From a
clone of this repo (CloudShell has `git` and `jq`), the whole of **simple** is:

```sh
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws iam create-policy --policy-name voice-agent-deploy-iam \
  --policy-document "$(jq -c 'del(.Comment)' infra/aws/operator-bootstrap-policy.json)"
aws iam attach-user-policy --user-name voice-agent-devs \
  --policy-arn "arn:aws:iam::$ACCOUNT:policy/voice-agent-deploy-iam"
```

and **strict** is the boundary first, then the deployer policy that requires it:

```sh
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
aws iam create-policy --policy-name voice-agent-boundary \
  --policy-document "$(jq -c 'del(.Comment)' infra/aws/voice-agent-boundary-policy.json)"
aws iam create-policy --policy-name voice-agent-deploy-iam \
  --policy-document "$(jq -c 'del(.Comment)' infra/aws/operator-bootstrap-policy-strict.json)"
aws iam attach-user-policy --user-name voice-agent-devs \
  --policy-arn "arn:aws:iam::$ACCOUNT:policy/voice-agent-deploy-iam"
# then create the stack with:
#   --parameter-overrides PermissionsBoundaryArn=arn:aws:iam::$ACCOUNT:policy/voice-agent-boundary
```

Without the repo, paste the same files into **IAM → Policies → Create policy → JSON**, minus the
`Comment` key.

**If the stack already failed for want of this**, grant the policy and then delete the stack —
cleanup now succeeds and takes the orphans with it, so nothing has to be removed by hand:

```sh
aws cloudformation delete-stack --stack-name voice-agent-staging-backend --region ca-central-1
aws cloudformation wait stack-delete-complete --stack-name voice-agent-staging-backend --region ca-central-1
```

**What neither can reach.** No EC2, RDS, S3 or KMS action appears in either file — only IAM. Every
statement that changes or deletes something is scoped by name to
`arn:aws:iam::<account>:{role,user,policy,instance-profile}/voice-agent-*`. Another project's
identities are invisible to it, and no instance or database can be touched. The two unscoped
statements are a read-only `List*` and `CreateServiceLinkedRole` limited by condition to
`rds.amazonaws.com` and `ssm.amazonaws.com`.

**What the simple one still allows, and the strict one does not.** Attaching a managed policy is
already restricted by `iam:PolicyARN` to our own `voice-agent-*` policies plus
`AmazonSSMManagedInstanceCore`, so the deployer cannot attach `AdministratorAccess` to itself.
What remains in the simple variant is `iam:CreateRole` together with `iam:PutRolePolicy`: a
`voice-agent-*` role that trusts the deployer and carries an inline `Action: *` is a way to
become administrator. Both actions are needed — CloudFormation writes the instance role's inline
policy — so the only real fix is the boundary, which forbids `iam:*` on anything the stack
creates. Choose **strict** in a shared account unless the deployer is already trusted that far.

**`Get*` and `Delete*` are not optional in either.** Tried on 22 Sep 2026 without them:
CloudFormation created the role and the user, was refused `iam:GetUser` when it read the user
back, failed the stack, and then could not delete either resource — `ROLLBACK_FAILED`, with two
orphaned IAM resources whose fixed names then collide with the next attempt.

**Grant nothing else up front.** Deploying also needs EC2, RDS, KMS, SSM and Secrets Manager
rights; if the developer's user is missing one, the stack names the exact action and resource,
and that is the moment to add a narrow statement. `PowerUserAccess` would cover all of them at
once, and would also allow terminating any instance in the account — in a shared account that is
the wrong trade for saving one round trip.

If the convention is that only an administrator touches IAM (this account already has a separate
`sceniq-iam` stack), the alternative is for the administrator to run step 1 and hand over the
outputs. Nothing after step 1 needs IAM rights.

### 1. The AWS stack (administrator, ~5 minutes)

Region **ca-central-1**: the company's other stacks are there, and the database now lives in
the same VPC as the instance (ADR 0016), so nothing crosses a region.

```sh
aws cloudformation deploy --region ca-central-1 \
  --stack-name voice-agent-staging-backend \
  --template-file infra/aws/backend-stack.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides EnvName=staging ApiDomain=api-staging.oraly.ai \
    VpcId=<default vpc id> SubnetId=<a public subnet in it> \
    OperatorIamUser=<the developer's IAM user name>
aws cloudformation describe-stacks --region ca-central-1 --stack-name voice-agent-staging-backend \
  --query 'Stacks[0].Outputs' --output table
```

Or the console: CloudFormation → Create stack → upload the file → the same parameters. It
creates: security group (80/443 in, nothing else), instance role (Session Manager, read
`/voice-agent/staging/*`, use the SIP key), `t3.small` Ubuntu 24.04 with IMDSv2, 2 GB of swap
and an encrypted 30 GB root volume, Elastic IP, KMS key `alias/voice-agent-staging-sip`, IAM user
`voice-agent-ci-staging` (may only run the deploy on that one instance), and managed policy
`voice-agent-operator-staging` (SSM parameters under the path, a shell on the box, manual
deploys). No SSH key, no port 22. Then, in the IAM console, **one access key for
`voice-agent-ci-staging`** — that is the only secret this step produces, and it goes straight
to GitHub (step 7).

The outputs are the inputs to everything below: `ElasticIp`, `InstanceId`, `Region`,
`SipCredentialsKmsKeyArn`, `CiUserName`.

### 2. DNS (Namecheap → Domain List → oraly.ai → Advanced DNS → Host Records)

Add one record; leave the parking `www` CNAME and `@` redirect until the frontend lands.

| Type     | Host          | Value         | TTL       |
| -------- | ------------- | ------------- | --------- |
| A Record | `api-staging` | `<ElasticIp>` | Automatic |

`dig +short api-staging.oraly.ai` shows the address within a few minutes (Namecheap's SOA
TTL is one hour at most). Nothing else in DNS until D8.

### 3. Database roles (developer)

The stack created the database. It has no public address, so reach it through the instance.
Open the tunnel in its own terminal and leave it running (the `DbTunnelCommand` stack output
is this command with the values filled in):

```sh
aws ssm start-session --region ca-central-1 --target <InstanceId> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<DbEndpoint>"],"portNumber":["5432"],"localPortNumber":["55432"]}'
```

In a second terminal, read the generated master password and run the migrations through the
tunnel. The master user exists for this and nothing else:

```sh
OWNER=$(aws secretsmanager get-secret-value --region ca-central-1 \
  --secret-id <DbMasterSecretArn> --query SecretString --output text \
  | jq -r '"postgresql://\(.username):\(.password|@uri)@localhost:55432/portal?sslmode=require"')

DIRECT_DATABASE_URL="$OWNER" pnpm db:deploy
DIRECT_DATABASE_URL="$OWNER" pnpm db:seed

DB_PUBLIC_HOST=<DbEndpoint> infra/scripts/db-env-roles.sh staging "$OWNER" ~/voice-agent.staging.env
```

`DB_PUBLIC_HOST` matters: the script talks to the database over the tunnel, but the three URLs
it writes must name the address **the instance** uses. Without it the box would be handed a
localhost port. `DATABASE_URL` is now `portal_app_staging` and RLS-enforced (the script
checks); the API refuses to boot on anything else.

### 4. The configuration file → SSM (developer)

Append the rest of the keys to `~/voice-agent.staging.env` (mode 600, `KEY=VALUE`, no
inline comments). What each one is on staging:

| Key                                                                                                                              | Staging value                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_DOMAIN`                                                                                                                     | `api-staging.oraly.ai`                                                                                                                             |
| `API_PUBLIC_URL`                                                                                                                 | `https://api-staging.oraly.ai` — baked into every Retell object at create time                                                                     |
| `PORTAL_URL`                                                                                                                     | `https://app-staging.oraly.ai` — every customer link and Stripe return URL; the portal is not deployed until D8, but `deploy.sh` refuses localhost |
| `ADMIN_URL`                                                                                                                      | `https://admin-staging.oraly.ai`                                                                                                                   |
| `ACME_EMAIL`                                                                                                                     | an ops mailbox for Let's Encrypt expiry notices                                                                                                    |
| `REDIS_URL`                                                                                                                      | `redis://redis:6379` (compose-internal; the compose file sets it too)                                                                              |
| `AUTH0_CUSTOMER_DOMAIN`, `AUTH0_CUSTOMER_AUDIENCE`, `AUTH0_CUSTOMER_ACTION_SECRET`, `AUTH0_STAFF_DOMAIN`, `AUTH0_STAFF_AUDIENCE` | the dev tenants for now (`dev-tpj0dmu6yauk2360` / `dev-uxrhx8onbftpb5vi`); `docs/runbooks/auth0.md` when staging gets its own                      |
| `RETELL_API_KEY`                                                                                                                 | the key of the **staging** Retell workspace (one workspace per environment, ADR 0003); objects are prefixed `staging-` by `APP_ENV`                |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                                                                                     | a **test-mode** restricted key and the secret of a webhook endpoint created in step 6 — never the dev `stripe listen` secret                       |
| `ANTHROPIC_API_KEY`, `GENERATION_MODEL`                                                                                          | as dev; `GENERATION_PROVIDER` stays `anthropic`                                                                                                    |
| `RECORDING_SIGNING_SECRET`                                                                                                       | `openssl rand -hex 32`                                                                                                                             |
| `SIP_CREDENTIALS_KMS_KEY_ID`, `AWS_REGION`                                                                                       | `SipCredentialsKmsKeyArn` output, `ca-central-1`                                                                                                   |
| `RESEND_API_KEY`, `EMAIL_FROM`                                                                                                   | Resend key once `oraly.ai` is verified there; `no-reply@oraly.ai`                                                                                  |
| `OPS_ALERT_WEBHOOK_URL`                                                                                                          | the Slack incoming webhook for ops alerts                                                                                                          |
| `INBOUND_REDIS_DOWN_POLICY`                                                                                                      | `open`                                                                                                                                             |
| `CAPTURE_FIXTURES`                                                                                                               | `false` on staging unless collecting payloads                                                                                                      |

Not in the file: `APP_ENV`, `BACKEND_IMAGE`, `BACKEND_TAG` (deploy.sh sets them) and anything
`NEXT_PUBLIC_*` / `AUTH0_CLIENT_ID` (frontend build-time, D8). Then:

```sh
infra/scripts/ssm-put-env.sh staging ~/voice-agent.staging.env --dry-run   # keys and lengths only
infra/scripts/ssm-put-env.sh staging ~/voice-agent.staging.env             # SecureStrings under /voice-agent/staging/
infra/scripts/ssm-put-env.sh staging --check                               # what deploy.sh will find
```

### 5. On the instance (developer, Session Manager — no SSH)

```sh
aws ssm start-session --region ca-central-1 --target <InstanceId>
sudo -i
test -f /var/log/voice-agent-bootstrap.done            # user data installed Docker, Compose, AWS CLI, git
GH_USER=<github user> GH_TOKEN=<classic PAT: repo + read:packages> \
  bash <(curl -fsSL -H "Authorization: token $GH_TOKEN" \
  https://raw.githubusercontent.com/Metacognixion-labs/AI_Voiceagent_MCX/develop/infra/scripts/instance-bootstrap.sh)
```

The repository is private, so the deploy's `git fetch` and `docker compose pull` need one
read-only token; the bootstrap stores it in root's docker config and `/root/.git-credentials`
and clones `develop` to `/opt/voice-agent/infra`. Then the first deploy, by hand, so the
first certificate issuance is watched:

```sh
/opt/voice-agent/infra/infra/scripts/deploy.sh staging develop     # image tag pushed by CI on develop
curl -sS https://api-staging.oraly.ai/health/ready | jq
```

`deploy.sh` exits non-zero when anything `/health/ready` reports is down.

### 6. Retell / Stripe / Auth0 (developer)

- **Retell**: nothing in the dashboard — the gateway writes `API_PUBLIC_URL` into every
  agent (`webhook_url`) and number (`inbound_webhook_url`) it creates. A staging agent made
  before this point has a dev URL baked in; recreate it.
- **Stripe** (test mode): `stripe webhook_endpoints create --url https://api-staging.oraly.ai/webhooks/stripe --enabled-events <StripeEventHandler.HANDLED>`; the printed `whsec_…` is
  `STRIPE_WEBHOOK_SECRET` — put it in SSM and redeploy.
- **Auth0**: add `https://app-staging.oraly.ai` to the customer SPA's callback / logout /
  web origins and `https://admin-staging.oraly.ai` to the staff SPA (D8, `infra/auth0/tenant.*.yaml`);
  the Post-User-Registration Action's URL becomes `https://api-staging.oraly.ai/webhooks/auth`.

### 7. GitHub → Settings → Environments → `staging`

Variables `STAGING_INSTANCE_ID` (output `InstanceId`), `AWS_REGION` (`ca-central-1`),
`STAGING_API_DOMAIN` (`api-staging.oraly.ai`); secrets `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` — the access key of `voice-agent-ci-staging`. From the next push to
`develop`, CI deploys.

## When a create fails

CloudFormation rolls back on its own, and the stack ends `ROLLBACK_COMPLETE` — delete it and
create again. If it ends **`ROLLBACK_FAILED`**, rollback itself was refused, and the reason is
almost always a missing `iam:Delete*` (step 0):

The banner on the stack — _"The following resource(s) failed to delete"_ — describes the
**cleanup**, not the failure. Two different questions, two queries (CloudShell is already in
the account, bottom-left of the console):

```sh
# 1. why the stack failed at all — the first row is the cause, the rest are cancellations
aws cloudformation describe-stack-events --stack-name voice-agent-staging-backend --region ca-central-1 \
  --query "reverse(StackEvents[?ResourceStatus=='CREATE_FAILED'].[LogicalResourceId,ResourceStatusReason])" \
  --output text

# 2. why rollback could not clean up — usually the literal AccessDenied it needed
aws cloudformation describe-stack-events --stack-name voice-agent-staging-backend --region ca-central-1 \
  --query "reverse(StackEvents[?ResourceStatus=='DELETE_FAILED'].[LogicalResourceId,ResourceStatusReason])" \
  --output text
```

A resource that failed to **delete** was created successfully, so the identity has
`iam:Create*` and the create failed somewhere else entirely — query 1 is the one that matters.

Fix the permission first, then `Delete stack` — it will now clean up what it left behind. If the
permission cannot be granted, delete with **Retain** on the resources it names, and have an
administrator remove them by hand. Every name in the template is fixed, so anything retained
collides with the next create and the second attempt fails with _already exists_:

| Retained                     | Delete before retrying (IAM → …)                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `InstanceRole`               | Roles → `voice-agent-<env>-instance` (detach it from the instance profile of the same name first) |
| `CiUser`                     | Users → `voice-agent-ci-<env>` (remove its access keys and attached policies first)               |
| `InstanceProfile`            | `aws iam delete-instance-profile --instance-profile-name voice-agent-<env>-instance`              |
| `CiPolicy`, `OperatorPolicy` | Policies → `voice-agent-ci-<env>`, `voice-agent-operator-<env>`                                   |

Nothing here collides with another project in the account: every name this template creates is
prefixed `voice-agent-`.

## Deploy

Automatic: every push to `develop` builds the image, publishes
`ghcr.io/metacognixion-labs/voice-agent-backend:sha-<7>` (and `:develop`; the org name is
lowercased because GHCR refuses `Metacognixion-labs`), then runs `deploy.sh staging sha-<7>`
on the instance over SSM Run Command and curls `/health` and `/health/ready` over TLS.

By hand, on the instance or through Run Command (the `DeployCommand` stack output):

```sh
sudo /opt/voice-agent/infra/infra/scripts/deploy.sh staging sha-abc1234   # deploy
sudo /opt/voice-agent/infra/infra/scripts/deploy.sh staging sha-9f8e7d6   # roll back = same command, previous tag
```

`deploy.sh` writes `/opt/voice-agent/.env` from SSM (root-only), copies the compose file and
Caddyfile, `docker compose pull && up -d --wait`, and prints `docker compose ps` and the
readiness JSON. `--wait` fails the deploy if a healthcheck does not pass; a non-200
`/health/ready` fails it too.

## Verify

| Check              | Command                                                                                          | Expect                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| DNS                | `dig +short api-staging.oraly.ai`                                                                | the Elastic IP                                                                                           |
| TLS + liveness     | `curl -sS https://api-staging.oraly.ai/health`                                                   | `{"status":"ok","service":"api","env":"staging",…}`                                                      |
| Readiness          | `curl -sS https://api-staging.oraly.ai/health/ready`                                             | `status: ready`, `checks.postgres.ok`, `checks.redis.ok`, `checks.worker.ok` with `schedulers: 13`       |
| Worker up          | `docker compose logs worker \| grep "job schedulers present"`                                    | `13 job schedulers present (13 registered, 0 removed, 12 live)`                                          |
| Schedules tick     | `docker compose logs worker \| grep "tick started"`                                              | one line per schedule per interval, `done in … ms` after each                                            |
| Redis              | `docker compose exec redis redis-cli ping`                                                       | `PONG`                                                                                                   |
| Webhooks reach us  | Retell dashboard → send test event; `docker compose logs api \| grep webhooks`                   | `200 {received:true}`; a replay → `204`                                                                  |
| Worker CPU cap     | `docker inspect voice-agent-worker-1 --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}'` | `1000000000 1073741824`                                                                                  |
| API uncapped       | `docker inspect voice-agent-api-1 --format '{{.HostConfig.NanoCpus}}'`                           | `0`                                                                                                      |
| Memory headroom    | `free -m`                                                                                        | ~1.3 GB used of 2 GB, **swap 0 used**. Swap in use means move this environment to `t3.medium` (ADR 0015) |
| No secrets in logs | `docker compose logs \| grep -Ei 'sk_(live\|test)\|key_[0-9a-f]{16}\|Bearer '`                   | nothing                                                                                                  |
| Config complete    | `infra/scripts/ssm-put-env.sh staging --check` (from the dev machine)                            | `every key deploy.sh requires is present`                                                                |

`pnpm doctor` on the instance (with the `.env`) reports anything still unset.

## Observability

- Every schedule tick logs `<name>: tick started` and `<name>: done in <ms> → {…}` or
  `failed after <ms>`; a skipped tick logs why (`another worker is still running this
schedule` / `Redis did not answer`).
- Money movements log with the workspace, the amount and the period: `number-rental <id>
(<ws>): charged 15 credits for period …`, `credit-expiry: N lots written off`, `auto top-up
purchase … credited`. Alerts: `low-balance <ws>: balance … ≤ … — alert … opened`,
  `concurrency <ws>: N live calls ≥ …`, `reconcile-calls <date>: … drift …% → ok|drift`.
- Ops alerts (`OpsAlertService`) go to `OPS_ALERT_WEBHOOK_URL` (Slack) and are always a log
  line: `reconcile_drift`, `reconcile_provider_error`, `workspace_concurrency`,
  `platform_concurrency`, `number_release_failed`, `activation_failed`, `auto_topup_failed`.
  Every field is redacted for secret-looking names and values.
- Nothing logs a password, a decrypted SIP credential, an API key, a token or a payment
  secret: the email sender logs recipient (masked) and subject only; webhook handlers log
  event type and ids.

## The portal (S3 + CloudFront, ADR 0008 / 0017)

One CloudFormation stack per app per environment, in **the same account and region as the
backend** except for the certificate, which CloudFront reads only from `us-east-1`:

**Both optional parameters can be left out on the first run**, and the stack still comes up in
about ten minutes on its own `*.cloudfront.net` name — deployable and testable immediately:

- `HostName` + `CertificateArn` — omit them and CloudFront serves its default certificate.
  Add both once ACM reads _Issued_; the aliases attach on a stack update.
- `CiUserName` — omit it and the stack creates **no IAM resource at all**, so it deploys
  without the permissions of step 0 and without `CAPABILITY_NAMED_IAM`. Deploys then run from
  the developer's own credentials; add the name later and the `deploy-portal-staging` job
  takes over.

That is the order to use while the backend is blocked: stack now, certificate and CI user when
they exist.

1. ACM, region `us-east-1`: request a certificate for `app-staging.oraly.ai`, DNS
   validation, add the CNAME at Namecheap, wait for _Issued_. Note the ARN.
2. Create the stack:

   ```sh
   aws cloudformation deploy --region ca-central-1 --stack-name voice-agent-staging-web \
     --template-file infra/aws/frontend-stack.yaml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides Environment=staging App=web HostName=app-staging.oraly.ai \
       CertificateArn=arn:aws:acm:us-east-1:…:certificate/… CiUserName=voice-agent-ci-staging
   aws cloudformation describe-stacks --stack-name voice-agent-staging-web --query 'Stacks[0].Outputs'
   ```

   It creates the private bucket, the OAC, the distribution with the `/path/ →
/path/index.html` viewer function, the no-cache HTML policy, the security headers,
   and grants the CI user sync + invalidation on exactly this bucket and distribution.

3. DNS: `app-staging` CNAME → the `DistributionDomainName` output.
4. Auth0 (customer tenant): the callback, logout and web-origin lists are `PORTAL_URL`
   plus the optional `PORTAL_ALT_URL`. Deploy with **both**, or staging replaces localhost
   and every developer's login starts answering _Callback URL mismatch_:

   ```sh
   PORTAL_URL=https://app-staging.oraly.ai PORTAL_ALT_URL=http://localhost:3000 \
     pnpm auth0:validate      # prints the list that would be sent
   PORTAL_URL=https://app-staging.oraly.ai PORTAL_ALT_URL=http://localhost:3000 \
     pnpm auth0:plan customer && … deploy customer
   ```

   The callback is the **app origin**, not a `/callback` path — a static export has no
   route handlers. Needs the M2M credentials (auth0.md §1), which are not in `.env` yet;
   until then it is four fields in the dashboard.

5. GitHub `staging` environment variables: `STAGING_PORTAL_BUCKET`,
   `STAGING_PORTAL_DISTRIBUTION_ID`, `STAGING_PORTAL_HOST`, `STAGING_AUTH0_DOMAIN`,
   `STAGING_AUTH0_CLIENT_ID`, `STAGING_AUTH0_AUDIENCE`, optionally `STAGING_POSTHOG_KEY` /
   `STAGING_POSTHOG_HOST`. `STAGING_API_DOMAIN` and the AWS keys are shared with the
   backend job. The `deploy-portal-staging` job then runs on every push to `develop`.
6. By hand, the same thing:

   ```sh
   FRONTEND_BUCKET=… FRONTEND_DISTRIBUTION_ID=… NEXT_PUBLIC_API_URL=https://api-staging.oraly.ai \
   NEXT_PUBLIC_AUTH0_DOMAIN=… NEXT_PUBLIC_AUTH0_CLIENT_ID=… NEXT_PUBLIC_AUTH0_AUDIENCE=… \
   infra/scripts/deploy-frontend.sh web staging
   ```

7. Verify: `https://app-staging.oraly.ai/login/` answers 200, the sign-in round-trip
   returns to the origin and lands on `/setup/workspace/`, `GET /events` streams (the
   generation progress bar moves), a PostHog `$pageview` arrives, and the theme toggle
   survives a reload. The scripted version of that check is
   `pnpm --filter @portal/web e2e:wizard` with `PORTAL_URL=https://app-staging.oraly.ai`
   and a real, verified test account — the local issuer is a dev-only stand-in.

The API's CORS origin is `PORTAL_URL` from SSM, so the portal host and `PORTAL_URL` must
agree, or every request from the browser fails the preflight.

## Where we stand (22 Sep 2026)

Done: the domain (`oraly.ai`, Namecheap), the template, the scripts, the compose file
(`docker compose config`), the image (`docker build -f infra/Dockerfile .`, both entrypoints),
the deploy script, the CI jobs, the readiness probe, the worker heartbeat. Fixed today: CI
published the image under the org's mixed-case name, which GHCR refuses, while the box
defaulted to a personal namespace; `deploy.sh` read the region from IMDS without a token,
which an IMDSv2 instance refuses, and fell back to `us-east-1`; the bootstrap had no
credential for the private repository the deploy fetches.

**Not done: step 1, and everything after it.** The AWS credentials on the development
machine are `skydiveos-deploy` (another project's deploy user in the same account): they can
list EC2 instances but are refused on security groups, Elastic IPs, IAM, SSM Parameter Store
and KMS, so the stack cannot be created from here — and should not be, under that user. What
unblocks it is an account administrator running step 1 (or granting the developer
`cloudformation:*` on `voice-agent-*` stacks plus the IAM/EC2/KMS/SSM rights the template
needs). Steps 2–7 are then the developer's, about two hours end to end, and CI deploys every
`develop` push from that point.

**Re-checked 22 Sep 2026, after D8.** Nothing has moved. `aws sts get-caller-identity` is
still `arn:aws:iam::878013573203:user/skydiveos-deploy`, and that user is now refused even
`cloudformation:ValidateTemplate`. The account holds certificates for `ultimatedzm.com` and
none for `oraly.ai`, and neither `app-staging` nor `api-staging.oraly.ai` resolves, so the
backend is not deployed either — a portal published on its own would load and then fail
every API call. `infra/aws/deployer-policy.json` is the least-privilege policy to hand the
account administrator: it is scoped to `voice-agent-*` stacks, buckets, CI users and managed
policies, and it covers the **frontend** stack only. The backend stack (ADR 0015/0016) needs
EC2, RDS, SSM Parameter Store and KMS on top of it.

**Order matters.** The backend stack comes first, or at least `api-staging.oraly.ai` must
answer, because the portal bakes `NEXT_PUBLIC_API_URL` in at build time and the API's CORS
origin is `PORTAL_URL` from SSM. Deploying the portal first only produces a login page that
cannot talk to anything.

What _is_ verified without AWS: the export builds (`pnpm --filter @portal/web build`), the
deploy script refuses a missing bucket, a missing distribution and a localhost
`NEXT_PUBLIC_API_URL`, and the wizard exit check passes 36/36 against a local API.
