#!/usr/bin/env bash
# Push an environment file into SSM Parameter Store, one SecureString per key — ADR 0015.
#
#   infra/scripts/ssm-put-env.sh staging ~/voice-agent.staging.env            # write
#   infra/scripts/ssm-put-env.sh staging ~/voice-agent.staging.env --dry-run  # say what would be written
#   infra/scripts/ssm-put-env.sh staging --check                              # what the instance would read
#
# The file is `KEY=VALUE` lines (blank lines and `#` comments ignored; no inline comments,
# a `#` in a value is part of the value). It lives OUTSIDE the repo and is never committed:
# .env.example lists the keys, docs/runbooks/staging.md says which value each takes on
# staging. Values are never printed, only key names and lengths. Runs with the operator
# policy from infra/aws/backend-stack.yaml (ssm:PutParameter on /voice-agent/<env>/*).
#
# deploy.sh turns every parameter under the path back into a `.env` line, so this is the
# only way configuration reaches the box (§17: nothing but .env.example in the repo).
set -euo pipefail

ENV_NAME="${1:?usage: ssm-put-env.sh <env> <file> [--dry-run] | <env> --check}"
shift
REGION="${AWS_REGION:-ca-central-1}"
PREFIX="/voice-agent/$ENV_NAME/"

# Keys deploy.sh refuses to start without. Kept in one place so a missing one is reported here,
# before a deploy fails on the instance.
REQUIRED=(DATABASE_URL ADMIN_DATABASE_URL REDIS_URL API_DOMAIN RETELL_API_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET AUTH0_CUSTOMER_DOMAIN AUTH0_STAFF_DOMAIN API_PUBLIC_URL PORTAL_URL)
# Not fatal on the box, but staging without them is a finding (pnpm doctor, D4–D7).
RECOMMENDED=(ACME_EMAIL AUTH0_CUSTOMER_AUDIENCE AUTH0_STAFF_AUDIENCE AUTH0_CUSTOMER_ACTION_SECRET ANTHROPIC_API_KEY RECORDING_SIGNING_SECRET SIP_CREDENTIALS_KMS_KEY_ID AWS_REGION RESEND_API_KEY EMAIL_FROM OPS_ALERT_WEBHOOK_URL SENTRY_DSN OTEL_EXPORTER_OTLP_ENDPOINT OTEL_EXPORTER_OTLP_HEADERS IMPERSONATION_SIGNING_SECRET)

report() {
  # $1: newline-separated key names present
  local present="$1" missing=0 key
  for key in "${REQUIRED[@]}"; do
    grep -qx "$key" <<<"$present" || { echo "!! required: $key" >&2; missing=$((missing + 1)); }
  done
  for key in "${RECOMMENDED[@]}"; do
    grep -qx "$key" <<<"$present" || echo " · recommended, not set: $key"
  done
  if [ "$missing" -gt 0 ]; then echo "$missing required key(s) missing for $ENV_NAME" >&2; return 1; fi
  echo "every key deploy.sh requires is present for $ENV_NAME"
}

if [ "${1:-}" = "--check" ]; then
  echo "» reading key names under $PREFIX ($REGION)"
  present=$(aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX" --recursive \
    --query 'Parameters[].Name' --output text | tr '\t' '\n' | sed "s#^$PREFIX##" | sort)
  printf '%s\n' "$present" | sed 's/^/  /'
  report "$present"
  exit
fi

FILE="${1:?usage: ssm-put-env.sh <env> <file> [--dry-run]}"
DRY_RUN=0
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1
[ -r "$FILE" ] || { echo "!! cannot read $FILE" >&2; exit 1; }
case "$(cd "$(dirname "$FILE")" && pwd)" in
  "$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)"*) echo "!! $FILE is inside the repository; keep environment files outside it (§17)" >&2; exit 1 ;;
esac
if [ "$(stat -f '%Lp' "$FILE" 2>/dev/null || stat -c '%a' "$FILE")" != "600" ]; then
  echo "!! $FILE must be mode 600 (chmod 600 '$FILE')" >&2; exit 1
fi

# Validate the whole file before writing anything.
present=""
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  [[ -z "${line// }" || "$line" =~ ^[[:space:]]*# ]] && continue
  if ! [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
    echo "!! $FILE:$n is not KEY=VALUE" >&2; exit 1
  fi
  key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
  value="${value%"${value##*[![:space:]]}"}"          # trailing whitespace
  [ -n "$value" ] || { echo "!! $FILE:$n: $key is empty — remove the line or set it" >&2; exit 1; }
  grep -qx "$key" <<<"$present" && { echo "!! $FILE:$n: $key appears twice" >&2; exit 1; }
  case "$key" in
    APP_ENV|BACKEND_IMAGE|BACKEND_TAG) echo "!! $FILE:$n: $key is set by deploy.sh, not by SSM" >&2; exit 1 ;;
    PORTAL_URL) [[ "$value" =~ localhost|127\.0\.0\.1 ]] && { echo "!! PORTAL_URL points at localhost; deploy.sh would refuse it" >&2; exit 1; } ;;
    API_PUBLIC_URL) [[ "$value" =~ ^https:// ]] || { echo "!! API_PUBLIC_URL must be https on $ENV_NAME (Retell bakes it into every agent)" >&2; exit 1; } ;;
  esac
  present+="$key"$'\n'
done <"$FILE"
present="${present%$'\n'}"

report "$present" || true
echo

while IFS= read -r line || [ -n "$line" ]; do
  [[ -z "${line// }" || "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]
  key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"; value="${value%"${value##*[![:space:]]}"}"
  if [ "$DRY_RUN" = 1 ]; then
    printf '  would write %-36s (%d chars)\n' "$PREFIX$key" "${#value}"
  else
    aws ssm put-parameter --region "$REGION" --name "$PREFIX$key" --type SecureString --overwrite \
      --value "$value" --query Version --output text >/dev/null
    printf '  wrote %-42s (%d chars)\n' "$PREFIX$key" "${#value}"
  fi
done <"$FILE"
[ "$DRY_RUN" = 1 ] && echo "dry run — nothing written" || echo "done — deploy.sh will read these on the next run"
