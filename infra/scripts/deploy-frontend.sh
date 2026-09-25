#!/usr/bin/env bash
# Build one frontend app and publish its static export to S3 + CloudFront (ADR 0008).
#
#   infra/scripts/deploy-frontend.sh <web|admin> <staging|prod> [--no-build]
#
# Required in the environment (CI secrets / vars, or a local shell):
#   FRONTEND_BUCKET            S3 bucket name         (stack output BucketName)
#   FRONTEND_DISTRIBUTION_ID   CloudFront id          (stack output DistributionId)
#   NEXT_PUBLIC_API_URL        https://api-staging.oraly.ai
#   NEXT_PUBLIC_AUTH0_DOMAIN, NEXT_PUBLIC_AUTH0_CLIENT_ID, NEXT_PUBLIC_AUTH0_AUDIENCE
#   NEXT_PUBLIC_POSTHOG_KEY, NEXT_PUBLIC_POSTHOG_HOST   (optional)
#   NEXT_PUBLIC_SUPPORT_EMAIL, NEXT_PUBLIC_STATUS_PAGE_URL   (optional, D7 Help)
# Plus AWS credentials for the CI user (s3 sync + cloudfront invalidation only).
#
# Two sync passes, one per cache policy: /_next/static/* is content-hashed and immutable
# for a year; everything else (HTML, JSON) is no-cache so a deploy is visible at once.
set -euo pipefail

APP="${1:?web|admin}"
ENV="${2:?staging|prod}"
NO_BUILD="${3:-}"

case "$APP" in web|admin) ;; *) echo "app must be web or admin" >&2; exit 2 ;; esac
case "$ENV" in staging|prod) ;; *) echo "env must be staging or prod" >&2; exit 2 ;; esac

: "${FRONTEND_BUCKET:?FRONTEND_BUCKET is required}"
: "${FRONTEND_DISTRIBUTION_ID:?FRONTEND_DISTRIBUTION_ID is required}"
: "${NEXT_PUBLIC_API_URL:?NEXT_PUBLIC_API_URL is required}"
: "${NEXT_PUBLIC_AUTH0_DOMAIN:?NEXT_PUBLIC_AUTH0_DOMAIN is required}"
: "${NEXT_PUBLIC_AUTH0_CLIENT_ID:?NEXT_PUBLIC_AUTH0_CLIENT_ID is required}"
: "${NEXT_PUBLIC_AUTH0_AUDIENCE:?NEXT_PUBLIC_AUTH0_AUDIENCE is required}"

case "$NEXT_PUBLIC_API_URL" in
  http://localhost*|http://127.*) echo "NEXT_PUBLIC_API_URL points at localhost; refusing to deploy $ENV" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="@portal/$APP"
OUT="$ROOT/frontend/$APP/out"

if [ "$NO_BUILD" != "--no-build" ]; then
  echo "▶ building $PKG for $ENV"
  export NEXT_PUBLIC_APP_ENV="$ENV"
  # Workspace packages first: @portal/schemas resolves to its gitignored dist/, which a
  # fresh checkout does not have. The app itself is built outside turbo, whose cache
  # covers .next/ but not out/ and would skip the export on a hit.
  (cd "$ROOT" && pnpm turbo run build --filter="$PKG^..." && pnpm --filter "$PKG" build)
fi
[ -f "$OUT/index.html" ] || { echo "no export at $OUT" >&2; exit 1; }

echo "▶ syncing immutable assets"
aws s3 sync "$OUT/_next/static" "s3://$FRONTEND_BUCKET/_next/static" \
  --cache-control "public, max-age=31536000, immutable" --delete --only-show-errors

echo "▶ syncing brand assets"
aws s3 sync "$OUT/brand" "s3://$FRONTEND_BUCKET/brand" \
  --cache-control "public, max-age=86400" --delete --only-show-errors

echo "▶ syncing pages"
aws s3 sync "$OUT" "s3://$FRONTEND_BUCKET" \
  --exclude "_next/static/*" --exclude "brand/*" \
  --cache-control "no-cache, no-store, must-revalidate" --delete --only-show-errors

echo "▶ invalidating CloudFront"
INVALIDATION_ID=$(aws cloudfront create-invalidation --distribution-id "$FRONTEND_DISTRIBUTION_ID" --paths "/*" --query 'Invalidation.Id' --output text)
aws cloudfront wait invalidation-completed --distribution-id "$FRONTEND_DISTRIBUTION_ID" --id "$INVALIDATION_ID"
echo "✓ $PKG deployed to $ENV (invalidation $INVALIDATION_ID)"
