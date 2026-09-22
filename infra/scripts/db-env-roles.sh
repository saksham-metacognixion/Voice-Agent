#!/usr/bin/env bash
# Create (or rotate) the two login roles one environment uses — ADR 0006, ADR 0016, provisioning §3.
#
#   infra/scripts/db-env-roles.sh staging "$OWNER_URL" ~/voice-agent.staging.env
#
# The database is private RDS (ADR 0016), so open the tunnel first, point OWNER_URL at it and
# name the real host so the env file does not hand the server a localhost port:
#   aws ssm start-session --target <instance> \
#     --document-name AWS-StartPortForwardingSessionToRemoteHost \
#     --parameters '{"host":["<db endpoint>"],"portNumber":["5432"],"localPortNumber":["55432"]}'
#   OWNER_URL=postgresql://portal:<master password>@localhost:55432/portal
#   DB_PUBLIC_HOST=<db endpoint>
#
# The migrations create the GROUP roles `portal_app` (RLS enforced) and `portal_admin`
# (BYPASSRLS); this creates `portal_app_<env>` / `portal_admin_<env>` LOGIN roles with fresh
# passwords, grants them the groups, and appends the three connection strings to the env
# file (created mode 600 if missing) for infra/scripts/ssm-put-env.sh:
#   DATABASE_URL        pooled, portal_app_<env>     — what the API and worker use
#   ADMIN_DATABASE_URL  pooled, portal_admin_<env>   — webhooks, schedules, /admin/*
#   DIRECT_DATABASE_URL the owner URL you passed      — migrations only (`pnpm db:deploy`)
# On Neon the pooled endpoint is the unpooled host with `-pooler` after the endpoint id and the
# script derives it; an RDS host is used as is, replaced by DB_PUBLIC_HOST when that is set. Run `pnpm db:deploy` against the owner URL FIRST or the groups do not exist.
# Nothing is printed but role names and the file path.
set -euo pipefail

ENV_NAME="${1:?usage: db-env-roles.sh <env> <owner connection url> <env file>}"
OWNER_URL="${2:?usage: db-env-roles.sh <env> <owner connection url> <env file>}"
OUT="${3:?usage: db-env-roles.sh <env> <owner connection url> <env file>}"
command -v psql >/dev/null || { echo "!! psql is required" >&2; exit 1; }
command -v node >/dev/null || { echo "!! node is required (URL parsing)" >&2; exit 1; }

APP_ROLE="portal_app_$ENV_NAME"
ADMIN_ROLE="portal_admin_$ENV_NAME"

# The groups come from the migration; refuse to invent them here.
for group in portal_app portal_admin; do
  psql "$OWNER_URL" -tAqc "select 1 from pg_roles where rolname = '$group'" | grep -qx 1 \
    || { echo "!! group role $group does not exist — run 'pnpm db:deploy' with DIRECT_DATABASE_URL=<owner url> first" >&2; exit 1; }
done

gen() { openssl rand -base64 36 | tr -d '/+=' | cut -c1-40; }
APP_PW="$(gen)"; ADMIN_PW="$(gen)"

upsert_role() {
  local role="$1" pw="$2" group="$3" verb
  if psql "$OWNER_URL" -tAqc "select 1 from pg_roles where rolname = '$role'" | grep -qx 1; then
    verb=rotated
    psql "$OWNER_URL" -qc "alter role \"$role\" with login password '$pw'"
  else
    verb=created
    psql "$OWNER_URL" -qc "create role \"$role\" with login password '$pw'"
  fi
  psql "$OWNER_URL" -qc "grant \"$group\" to \"$role\""
  echo "  $verb $role (member of $group)"
}
echo "» roles"
upsert_role "$APP_ROLE" "$APP_PW" portal_app
upsert_role "$ADMIN_ROLE" "$ADMIN_PW" portal_admin

# Build the pooled URLs: same host with `-pooler` on the endpoint label, new credentials,
# the same database and query string. Passwords are URL-encoded.
urls=$(OWNER_URL="$OWNER_URL" APP_ROLE="$APP_ROLE" APP_PW="$APP_PW" ADMIN_ROLE="$ADMIN_ROLE" ADMIN_PW="$ADMIN_PW" DB_PUBLIC_HOST="${DB_PUBLIC_HOST:-}" node -e '
  const u = new URL(process.env.OWNER_URL);
  // DB_PUBLIC_HOST is what the SERVER reaches the database on, when this script connected
  // through a tunnel. Without it the env file would hand the instance a localhost port.
  const tunnelled = Boolean(process.env.DB_PUBLIC_HOST);
  const real = process.env.DB_PUBLIC_HOST || u.hostname;
  const [label, ...rest] = real.split(".");
  // Only Neon has the -pooler endpoint; an RDS or local host is used as is.
  const isNeon = real.endsWith(".neon.tech");
  const host = !isNeon || label.endsWith("-pooler") ? real : [label + "-pooler", ...rest].join(".");
  const at = (url, name) => { url.hostname = name; if (tunnelled) url.port = "5432"; return url; };
  const make = (user, pw) => { const p = at(new URL(u), host); p.username = user; p.password = pw; return p.toString(); };
  process.stdout.write(`DATABASE_URL=${make(process.env.APP_ROLE, process.env.APP_PW)}\nADMIN_DATABASE_URL=${make(process.env.ADMIN_ROLE, process.env.ADMIN_PW)}\nDIRECT_DATABASE_URL=${at(new URL(u), real).toString()}\n`);
')

umask 077
touch "$OUT"; chmod 600 "$OUT"
# Replace existing lines for these keys, append the rest.
tmp="$(mktemp)"; grep -vE '^(DATABASE_URL|ADMIN_DATABASE_URL|DIRECT_DATABASE_URL)=' "$OUT" > "$tmp" || true
{ cat "$tmp"; printf '%s\n' "$urls"; } > "$OUT"; rm -f "$tmp"
echo "» wrote DATABASE_URL, ADMIN_DATABASE_URL, DIRECT_DATABASE_URL to $OUT (mode 600)"

# The API refuses an owner DATABASE_URL at boot; prove the app role is not one. The written
# URL may name a host only the server can reach, so probe over the same connection we used.
PROBE_URL="$(node -e 'const u=new URL(process.argv[1]);u.username=process.argv[2];u.password=process.argv[3];process.stdout.write(u.toString())' "$OWNER_URL" "$APP_ROLE" "$APP_PW")"
if psql "$PROBE_URL" -tAqc "select rolsuper or rolbypassrls from pg_roles where rolname = current_user" | grep -qx t; then
  echo "!! $APP_ROLE bypasses RLS — that must not happen; check the grants" >&2; exit 1
fi
echo "» $APP_ROLE connects and is RLS-enforced"
