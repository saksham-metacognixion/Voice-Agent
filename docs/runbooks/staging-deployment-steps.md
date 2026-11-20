# How staging was deployed, step by step

This is the order the staging environment was actually built in, 22–23 Sep 2026, with the
real values and every trap hit on the way. Production is the same list with the differences
at the end. The details behind each step (what the template creates, the full key table)
are in [staging.md](staging.md), and the narrative record of the run is
[staging-deploy-log.md](staging-deploy-log.md). No secret is written here, only where it lives.

## The result

| Piece         | Where                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------- |
| Portal        | `https://app-staging.oraly.ai`: S3 bucket `voice-agent-staging-web-667723749107`, CloudFront `E1CBZ11YO807QN` (`d2omk7z1zamdxx.cloudfront.net`) |
| API           | `https://api-staging.oraly.ai`: EC2 `i-0f90a16bb513e2d6d` (`t3.small`), Elastic IP `16.52.177.152` |
| Containers    | `api`, `worker` (1 CPU / 1 GB cap), `redis`, `caddy` (TLS), via Docker Compose               |
| Database      | RDS Postgres 16 `voice-agent-staging.chme08mmqijq.ca-central-1.rds.amazonaws.com`, private  |
| Configuration | 31 SecureStrings under SSM `/voice-agent/staging/`                                           |
| AWS           | account `667723749107`, region `ca-central-1` (the portal certificate is in `us-east-1`)    |
| Stacks        | `voice-agent-staging-backend` (backend) and `voice-agent-staging-web` (portal)               |
| CI            | GitHub Actions on every push to `develop`: `check` → `image` → `deploy-staging` and `deploy-portal-staging` |

## Before you start: the laptop

1. **The right AWS account.** The `default` profile on this Mac is SkydiveOS
   (`skydiveos-deploy`, account 878013573203) and is refused on everything here. Use the
   `voice-agent` profile (`voice-agent-devs`, account 667723749107):

   ```sh
   export AWS_PROFILE=voice-agent          # in every new terminal
   aws sts get-caller-identity              # must say 667723749107
   ```

2. **`session-manager-plugin`** (`brew install --cask session-manager-plugin`). Without it
   `aws ssm start-session` cannot open a shell or a tunnel. There is no SSH and no port 22.
3. `jq`, `psql`, and `gh` (run `gh auth login` once).

## Part A: the backend

### A1. IAM permissions (the account admin, once per account)

The stack creates an instance role and a CI user, so the deployer needs IAM rights that
`PowerUserAccess` does not include. Pramod attached **`voice-agent-deploy-iam`** to
`voice-agent-devs`. It only allows creating roles and users that carry the permissions
boundary **`arn:aws:iam::667723749107:policy/VoiceAgentBoundary`**, so the stack must be
deployed with `PermissionsBoundaryArn` set.

> **Trap:** the first attempt had `iam:Create*` but not `Get*`/`Delete*`. CloudFormation
> created the CI user, could not read it back, failed, then could not delete it:
> `ROLLBACK_FAILED` with orphans whose fixed names block the next try. `Get*` and `Delete*`
> are required.

### A2. Create the backend stack (~15 minutes, RDS is the slow part)

```sh
aws cloudformation deploy --region ca-central-1 \
  --stack-name voice-agent-staging-backend \
  --template-file infra/aws/backend-stack.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides EnvName=staging ApiDomain=api-staging.oraly.ai \
    VpcId=vpc-0379a2b8999bd6fdf SubnetId=subnet-07b5e1af748e6f8f9 \
    PermissionsBoundaryArn=arn:aws:iam::667723749107:policy/VoiceAgentBoundary

aws cloudformation describe-stacks --region ca-central-1 --stack-name voice-agent-staging-backend \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
```

It creates the EC2 box, Elastic IP, security group (80/443 only), private RDS, the KMS key
for SIP passwords, the instance role, and the CI user `voice-agent-ci-staging`. The outputs
include ready-made commands: `DbTunnelCommand`, `DbOwnerUrlCommand`, `DeployCommand`. Use
`--output text` as above; the table format is too wide for a terminal.

Then create **one access key for `voice-agent-ci-staging`** in the IAM console. It goes
straight into GitHub (A8) and nowhere else.

### A3. DNS for the API (Namecheap → oraly.ai → Advanced DNS)

| Type | Host          | Value           |
| ---- | ------------- | --------------- |
| A    | `api-staging` | `16.52.177.152` |

Do this early: Caddy cannot get its Let's Encrypt certificate until the name resolves to the
box. Check with `dig +short api-staging.oraly.ai`.

### A4. The database: migrations, seed, login roles

The database has no public address, so everything goes through an SSM tunnel via the box.

**Terminal 1**, the tunnel (leave it running):

```sh
aws ssm start-session --region ca-central-1 --target i-0f90a16bb513e2d6d \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["voice-agent-staging.chme08mmqijq.ca-central-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["55432"]}'
```

**Terminal 2**:

```sh
OWNER=$(aws secretsmanager get-secret-value --region ca-central-1 \
  --secret-id 'arn:aws:secretsmanager:ca-central-1:667723749107:secret:rds!db-fe837eb4-7098-4ac6-9e8e-ac359420fc98-KL7C7L' \
  --query SecretString --output text \
  | jq -r '"postgresql://\(.username):\(.password|@uri)@localhost:55432/portal?sslmode=require"')

DIRECT_DATABASE_URL="$OWNER" pnpm db:deploy     # 10 migrations: tables, RLS, roles, append-only triggers
DIRECT_DATABASE_URL="$OWNER" pnpm db:seed       # packs, pricing v1, agent stack, templates, flags

DB_PUBLIC_HOST=voice-agent-staging.chme08mmqijq.ca-central-1.rds.amazonaws.com \
  infra/scripts/db-env-roles.sh staging "$OWNER" ~/voice-agent.staging.env
```

The last script creates the two login roles the app uses (`portal_app_staging` with RLS
enforced, `portal_admin_staging`) and writes the three `*DATABASE_URL`s into the env file.
`DB_PUBLIC_HOST` makes those URLs name the RDS host rather than the tunnel's localhost port.

Result: 51 tables, both roles checked.

### A5. Configuration into SSM

Fill the rest of `~/voice-agent.staging.env` (outside the repo, mode 600, `KEY=VALUE`). The
full key list with staging values is the table in [staging.md §4](staging.md). Then:

```sh
infra/scripts/ssm-put-env.sh staging ~/voice-agent.staging.env --dry-run   # key names and lengths only
infra/scripts/ssm-put-env.sh staging ~/voice-agent.staging.env             # writes /voice-agent/staging/*
infra/scripts/ssm-put-env.sh staging --check                               # what deploy.sh will find
```

31 parameters. The Anthropic, Stripe test and Auth0 values were reused from dev;
`RECORDING_SIGNING_SECRET` was generated fresh (`openssl rand -hex 32`). `RESEND_API_KEY`
and `OPS_ALERT_WEBHOOK_URL` were left out on purpose, so emails and ops alerts are log lines
for now. Leave a key out entirely: the script refuses an empty value.

### A6. Stripe webhook endpoint (test mode)

Create an endpoint at `https://api-staging.oraly.ai/webhooks/stripe` subscribed to exactly
`StripeEventHandler.HANDLED`. Put its `whsec_…` into SSM as `STRIPE_WEBHOOK_SECRET`. Stripe does
not check that the URL is live, so this can happen before the first deploy.

### A7. Bootstrap the instance and deploy once by hand

```sh
aws ssm start-session --region ca-central-1 --target i-0f90a16bb513e2d6d
sudo -i
test -f /var/log/voice-agent-bootstrap.done     # user data already installed Docker, Compose, AWS CLI, git
GH_USER=<github user> GH_TOKEN=<classic PAT: repo + read:packages> \
  bash <(curl -fsSL -H "Authorization: token $GH_TOKEN" \
  https://raw.githubusercontent.com/Metacognixion-labs/AI_Voiceagent_MCX/develop/infra/scripts/instance-bootstrap.sh)

/opt/voice-agent/infra/infra/scripts/deploy.sh staging develop
```

The bootstrap logs in to GHCR and clones the private repo to `/opt/voice-agent/infra`.
**Use a classic token; fine-grained tokens do not work with GHCR.** `deploy.sh` reads SSM
into a root-only `.env`, pulls the image, starts the four containers and waits for
`/health/ready`. It exits non-zero if anything is down. First deploy: 23 Sep 11:36 IST.

> **Trap:** CI had never published an image, because `check` was failing and `image`
> depends on it. Two fixes before the pull worked: GHCR refuses the mixed-case org name
> (`Metacognixion-labs` → lowercase), and `deploy.sh` needed an IMDSv2 token to read the
> region (commit `ab91e84`). Then the worker test needed Auth0 placeholders that only a
> local `.env` had been supplying (`e6a01b6`).

### A8. GitHub → Settings → Environments → `staging` (backend)

| Kind     | Name                                           | Value                                   |
| -------- | ---------------------------------------------- | --------------------------------------- |
| Variable | `STAGING_INSTANCE_ID`                          | `i-0f90a16bb513e2d6d`                   |
| Variable | `AWS_REGION`                                   | `ca-central-1`                          |
| Variable | `STAGING_API_DOMAIN`                           | `api-staging.oraly.ai`                  |
| Secret   | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`  | the `voice-agent-ci-staging` access key |

From here every push to `develop` builds `ghcr.io/metacognixion-labs/voice-agent-backend:sha-<7>`
and runs `deploy.sh` on the box through SSM Run Command.

## Part B: the portal

### B1. Certificate (ACM, region **us-east-1**, since CloudFront only reads certificates there)

Request a certificate for `app-staging.oraly.ai` with DNS validation, add the validation
CNAME it shows at Namecheap, and wait for **Issued**.

### B2. Create the portal stack

```sh
aws cloudformation deploy --region ca-central-1 --stack-name voice-agent-staging-web \
  --template-file infra/aws/frontend-stack.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides Environment=staging App=web HostName=app-staging.oraly.ai \
    CertificateArn=arn:aws:acm:us-east-1:667723749107:certificate/33883380-9aa7-4534-9258-461b5b4a3525 \
    CiUserName=voice-agent-ci-staging
```

It creates the private bucket, CloudFront with origin access control, the `/path/ →
/path/index.html` function, no-cache for HTML, and security headers. It also lets the CI user
sync and invalidate exactly this bucket and distribution. `HostName` and `CertificateArn` are
optional: without them the stack still comes up on its `*.cloudfront.net` name, and they can be
added by a stack update once ACM says Issued. That is what happened here (created 06:48 UTC,
certificate attached 07:15).

### B3. DNS for the portal

| Type  | Host          | Value                           |
| ----- | ------------- | ------------------------------- |
| CNAME | `app-staging` | `d2omk7z1zamdxx.cloudfront.net` |

### B4. GitHub `staging` environment (portal)

| Variable                         | Value                                    |
| -------------------------------- | ---------------------------------------- |
| `STAGING_PORTAL_BUCKET`          | `voice-agent-staging-web-667723749107`   |
| `STAGING_PORTAL_DISTRIBUTION_ID` | `E1CBZ11YO807QN`                         |
| `STAGING_PORTAL_HOST`            | `app-staging.oraly.ai`                   |
| `STAGING_AUTH0_DOMAIN`           | `dev-tpj0dmu6yauk2360.us.auth0.com`      |
| `STAGING_AUTH0_CLIENT_ID`        | the "Voice Agent" SPA's client id        |
| `STAGING_AUTH0_AUDIENCE`         | the customer API audience                |
| `STAGING_POSTHOG_KEY` / `_HOST`  | optional                                 |

The job `deploy-portal-staging` then runs `infra/scripts/deploy-frontend.sh web staging` on
every push: build, sync `_next/static` as immutable, sync pages as no-cache, invalidate
CloudFront, and finally `curl https://$STAGING_PORTAL_HOST/login/`.

> **Trap 1:** `Module not found: Can't resolve '@portal/schemas'` on CI only.
> `@portal/schemas` resolves to its gitignored `dist/`. A laptop has a stale one, a fresh CI
> checkout does not. `deploy-frontend.sh` now builds the app's workspace dependencies first
> (`pnpm turbo run build --filter=@portal/web^...`) and then the app itself outside Turbo,
> because Turbo's cache covers `.next/` but not `out/` (commit `95b24f6`).
>
> **Trap 2:** `curl: (6) Could not resolve host: login`. `STAGING_PORTAL_HOST` was unset, so
> the URL was `https:///login/`. The step now fails with a clear message instead (`8e07d31`).

By hand, the same deploy (build-time values are baked into the bundle):

```sh
FRONTEND_BUCKET=voice-agent-staging-web-667723749107 FRONTEND_DISTRIBUTION_ID=E1CBZ11YO807QN \
NEXT_PUBLIC_API_URL=https://api-staging.oraly.ai NEXT_PUBLIC_AUTH0_DOMAIN=dev-tpj0dmu6yauk2360.us.auth0.com \
NEXT_PUBLIC_AUTH0_CLIENT_ID=… NEXT_PUBLIC_AUTH0_AUDIENCE=… \
infra/scripts/deploy-frontend.sh web staging
```

## Part C: Auth0 (one customer tenant, shared by dev and staging)

1. **Applications → "Voice Agent" → Settings.** Allowed Callback URLs, Allowed Logout URLs
   and Allowed Web Origins each read `https://app-staging.oraly.ai, http://localhost:3000`.
   The callback is the app **origin**, not a `/callback` path. List both: adding staging
   by replacing the value is what broke localhost login with _Callback URL mismatch_.
2. **Actions → Library → `customer-post-login`.** The code must be exactly
   [infra/auth0/actions/customer-post-login.js](../../infra/auth0/actions/customer-post-login.js).
   Secrets: `API_PUBLIC_URL = https://api-staging.oraly.ai`, and `ACTION_SECRET` = SSM
   `/voice-agent/staging/AUTH0_CUSTOMER_ACTION_SECRET`. **Deploy**, then **Triggers →
   post-login**: the action in the flow, **Apply**.
3. **`customer-post-registration`**, the same way, bound to **Post User Registration** (not
   yet created in the tenant, see _Still open_).

> **Trap:** sign-up succeeded but every API call answered `UNAUTHENTICATED — We have no
> account for this sign-in yet.` The dashboard copy of `customer-post-login` had been
> hand-edited and used an undefined `emailVerified`. It threw before stamping
> `https://portal/email`, so the API had no email to create the user row from. Pasting the
> repo file fixed it. After changing an action, **log out and in again**: the old token
> keeps failing.
>
> Because dev and staging share this tenant, `API_PUBLIC_URL` can point at one API only.
> Local sign-in still works: the API creates the row from the token's email claim.

## Part D: first run on a fresh environment

- **Voice catalogue.** `voice-cache` runs daily at 05:00 UTC only. The worker first started
  at 08:22 UTC, so W3 showed "The voice catalogue is being refreshed" until it was run
  once by hand, from a Session Manager shell on the box:

  ```sh
  sudo docker exec voice-agent-worker-1 node -e "const {Queue}=require('bullmq');const u=new URL(process.env.REDIS_URL);const q=new Queue('scheduled',{prefix:'portal:staging',connection:{host:u.hostname,port:Number(u.port||6379),password:u.password||undefined}});q.add('voice-cache',{},{jobId:'voice-cache-manual-'+Date.now(),attempts:1}).then(j=>{console.log('queued',j.id);return q.close()})"
  sudo docker logs --since 2m voice-agent-worker-1 2>&1 | grep -i voice-cache    # "N of N voices refreshed"
  ```

- **CORS.** `PATCH` must be in the API's allowed methods (it is, `backend/api/src/main.ts`).
  A browser error about PATCH right after a deploy came from the older image; a hard reload
  cleared it.

## Part E: verify

```sh
curl -sS https://api-staging.oraly.ai/health/ready | jq      # status ready; postgres, redis, worker ok; schedulers 13
curl -sS -o /dev/null -w '%{http_code}\n' https://app-staging.oraly.ai/login/    # 200
curl -sS -D - -o /dev/null -X OPTIONS -H 'Origin: https://app-staging.oraly.ai' \
  -H 'Access-Control-Request-Method: PATCH' https://api-staging.oraly.ai/workspace | grep -i allow
```

Then the D8 exit check in a browser, passed 23 Sep 2026: sign up with a real email →
verify → create workspace (20 credits) → W1 template → W2 brief → **Generate** (a version
is written) → W3 voices list and a voice can be chosen.

## Everyday operations

| Task                         | How                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Deploy                       | push to `develop`                                                                                     |
| Deploy or roll back by hand  | on the box: `sudo /opt/voice-agent/infra/infra/scripts/deploy.sh staging sha-<7>` (a previous tag rolls back) |
| Shell on the box             | `aws ssm start-session --region ca-central-1 --target i-0f90a16bb513e2d6d`                            |
| Logs                         | on the box: `sudo docker logs --since 30m voice-agent-api-1` (or `-worker-1`, `-caddy-1`)             |
| Change a config value        | edit `~/voice-agent.staging.env` → `ssm-put-env.sh staging …` → redeploy                              |
| Look at the database         | open the tunnel (A4), then pgAdmin or `psql` on `localhost:55432`, db `portal`, SSL `require`         |
| Master DB password           | `DbOwnerUrlCommand` output, or the Secrets Manager call in A4. **RDS rotates it every 7 days**        |
| App DB URLs                  | `aws ssm get-parameter --with-decryption --name /voice-agent/staging/DATABASE_URL …` (swap the host for `localhost:55432` over the tunnel) |

pgAdmin: host **`localhost`** (not the RDS name), port `55432`, SSL mode `require`, the SSH
Tunnel tab off. A `connection timeout expired` means the tunnel is not running; SSM closes
it after about 20 idle minutes. The master login bypasses RLS, so use it only to read.

## Still open

- Create `customer-post-registration` in the Auth0 tenant and bind it.
- Point Retell at staging before D9. Agents and numbers get `API_PUBLIC_URL` baked in when
  they are created, and staging still shares a Retell workspace with dev, which will show up
  as reconciliation drift.
- Fill `voices` on worker boot when the table is empty, so a fresh environment never needs Part D.
- `RESEND_API_KEY` and `OPS_ALERT_WEBHOOK_URL` on staging.
- `APP_ENV` does not reach Turbo tasks in CI (strict env mode).
- Rotate the Stripe webhook secret and the Retell key that were pasted into a chat while being set.
- Admin console (`admin-staging.oraly.ai`): same Part B with `App=admin`, due D12–D13.

## What production changes

`EnvName=prod`, `t3.medium`, RDS at least `db.t4g.small` with Multi-AZ (deletion
protection is automatic), `PermissionsBoundaryArn` from the start, hosts without
`-staging`, a second certificate, its own CI user `voice-agent-ci-prod`, its own Retell
workspace, **Stripe live keys**, and **its own Auth0 tenants**. That last one removes the
shared-callback and single-`API_PUBLIC_URL` problems in Part C. Resend and the ops alert
webhook become required.
