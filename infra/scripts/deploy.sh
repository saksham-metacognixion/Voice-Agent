#!/usr/bin/env bash
# Deploy (or roll back) the backend on an EC2 instance — ADR 0004, D7.
#
#   sudo infra/scripts/deploy.sh staging sha-abc1234
#
# Runs ON THE INSTANCE (CI reaches it through SSM Run Command; see .github/workflows/ci.yml).
# It writes `.env` from SSM Parameter Store (/voice-agent/<env>/*), records the image tag,
# pulls, applies the image's migrations (ADR 0034), and restarts only what changed. Rollback
# is the same command with the previous tag — migrations only go forward, so a rollback runs
# the older code against the newer schema (additive migrations keep that safe).
#
# Requires: docker compose v2, aws cli v2, an instance role with ssm:GetParametersByPath
# on /voice-agent/<env>/ and secretsmanager:GetSecretValue on the database master secret
# (nothing wider), and read access to the image registry
# (`docker login ghcr.io` once with a read-only token, stored in the instance's docker config).
set -euo pipefail

ENV_NAME="${1:?usage: deploy.sh <env> <image tag>}"
TAG="${2:?usage: deploy.sh <env> <image tag>}"
APP_DIR="${APP_DIR:-/opt/voice-agent}"
# The instance requires IMDSv2 (infra/aws/backend-stack.yaml), so the region lookup needs a
# token; an untokened GET is refused and would silently have deployed against a default region.
imds_region() {
  local token
  token=$(curl -fsS -X PUT --max-time 2 -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token 2>/dev/null) || return 1
  curl -fsS --max-time 2 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/region 2>/dev/null
}
REGION="${AWS_REGION:-$(imds_region || true)}"
[ -n "$REGION" ] || { echo "!! cannot determine the AWS region (IMDS unreachable and AWS_REGION unset)" >&2; exit 1; }
# Lowercase org: GHCR refuses `Metacognixion-labs`. CI passes the exact name it pushed as BACKEND_IMAGE.
IMAGE="${BACKEND_IMAGE:-ghcr.io/metacognixion-labs/voice-agent-backend}"

mkdir -p "$APP_DIR/caddy"
cd "$APP_DIR"

# 1. Configuration from SSM, never from the repo. Values land in a root-only .env.
echo "» reading /voice-agent/$ENV_NAME/* from SSM ($REGION)"
umask 077
aws ssm get-parameters-by-path --region "$REGION" --path "/voice-agent/$ENV_NAME/" --with-decryption --recursive \
  --query 'Parameters[].[Name,Value]' --output text \
  | awk -F'\t' -v prefix="/voice-agent/$ENV_NAME/" '{ name=$1; sub(prefix, "", name); print name "=" $2 }' > .env.next
# Every parameter is one line; a value with a newline would break the file, so refuse it.
if grep -qv '^[A-Z0-9_]\+=' .env.next; then echo "!! .env.next has a malformed line; aborting" >&2; exit 1; fi
{
  echo "APP_ENV=$ENV_NAME"
  echo "BACKEND_IMAGE=$IMAGE"
  echo "BACKEND_TAG=$TAG"
  cat .env.next
} > .env
rm -f .env.next
umask 022

# The API refuses to boot on a superuser/owner DATABASE_URL (assertRlsEnforced); fail early here too.
for key in DATABASE_URL ADMIN_DATABASE_URL REDIS_URL API_DOMAIN RETELL_API_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET AUTH0_CUSTOMER_DOMAIN AUTH0_STAFF_DOMAIN API_PUBLIC_URL PORTAL_URL; do
  grep -q "^$key=" .env || { echo "!! $key is not set in SSM for $ENV_NAME" >&2; exit 1; }
done
# Every customer email (low balance, rental, release, digest) and every Stripe return URL is
# built from PORTAL_URL, and the code falls back to localhost when it is missing. A box that
# boots with that fallback mails customers a link to http://localhost:3000, so refuse it here.
if grep -Eq '^PORTAL_URL=.*(localhost|127\.0\.0\.1)' .env; then
  echo "!! PORTAL_URL in SSM for $ENV_NAME points at localhost" >&2; exit 1
fi

# 2. Compose files come with the deploy (CI copies them next to this script).
cp -f "$(dirname "$0")/../docker-compose.prod.yml" docker-compose.yml
cp -f "$(dirname "$0")/../caddy/Caddyfile" caddy/Caddyfile

# 3. Pull, migrate, then restart what changed. `--wait` blocks until healthchecks pass or fails the deploy.
echo "» deploying $IMAGE:$TAG to $ENV_NAME"
docker compose pull --quiet

# Migrations from the image being deployed, before anything restarts (ADR 0034): new code in
# front of an old schema is a 500 on every route that reads a new table. A failure stops here
# and the running containers keep the previous image. The owner password is the RDS-managed
# secret, read now because it rotates weekly; it goes to this one container and never to .env.
# SKIP_MIGRATIONS=1 is for an operator who has already migrated by hand through the tunnel.
if [ "${SKIP_MIGRATIONS:-0}" = 1 ]; then
  echo "» SKIP_MIGRATIONS=1: not migrating; the schema must already match $TAG"
else
  secret_arn="$(sed -n 's/^DB_MASTER_SECRET_ARN=//p' .env)"
  if [ -n "$secret_arn" ]; then
    DB_OWNER_SECRET="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$secret_arn" --query SecretString --output text)" \
      || { echo "!! cannot read the database owner secret; nothing was restarted" >&2; exit 1; }
    export DB_OWNER_SECRET
  elif ! grep -q '^DIRECT_DATABASE_URL=' .env; then
    echo "!! neither DB_MASTER_SECRET_ARN nor DIRECT_DATABASE_URL is in SSM for $ENV_NAME; cannot migrate" >&2; exit 1
  fi
  echo "» migrating $ENV_NAME to $TAG"
  docker compose run --rm --no-deps -e DB_OWNER_SECRET migrate \
    || { echo "!! migrations failed; nothing was restarted, $ENV_NAME still runs the previous image" >&2; exit 1; }
  unset DB_OWNER_SECRET
fi

docker compose up -d --remove-orphans --wait --wait-timeout 180
docker image prune -f >/dev/null

# 4. Say what is running.
docker compose ps
# A 503 here (Postgres, Redis or the worker heartbeat missing) is a failed deploy, not a
# note: exit non-zero so the CI job goes red instead of printing the status and passing.
echo "» readiness:"
docker compose exec -T api node -e "fetch('http://127.0.0.1:4000/health/ready').then(async r=>{console.log(r.status, await r.text());process.exit(r.status===200?0:1)}).catch(e=>{console.error(e);process.exit(1)})" \
  || { echo "!! $ENV_NAME is not ready after deploying $TAG (see /health/ready above)" >&2; exit 1; }
echo "deployed $TAG to $ENV_NAME"
