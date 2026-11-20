# ADR 0008 — Frontend hosting: S3 + CloudFront + ACM, static export

- Status: accepted
- Date: 2026-09-14
- Deciders: Saksham
- Supersedes: [ADR 0005](0005-frontend-hosting-aws-amplify.md) in full, and the **Frontend SDK** row of
  [ADR 0002](0002-auth-provider-auth0.md) (`@auth0/nextjs-auth0` v4 → `@auth0/auth0-spa-js`)

## Context

ADR 0005 chose Amplify Hosting on this premise: *"Both apps need full Next.js server features: the
Auth0 SDK relies on middleware and route handlers for login, callback and session refresh, and the
wizard and dashboard render per-user data server-side."*

That premise is circular. The apps need server features **because ADR 0002 picked a server-side
Auth0 SDK** — not because the product requires server rendering. Checking the actual constraints:

- **The spec does not require SSR.** Neither `docs/spec-extract/portal-spec.txt` nor
  `admin-spec.txt` mentions Auth0, Next.js server rendering, middleware or route handlers. Nothing
  at rank 1 is in play.
- **Nothing is built yet.** `frontend/web` and `frontend/admin` are scaffolds — `app/layout.tsx`,
  `app/page.tsx`, `globals.css`, config. `@auth0/nextjs-auth0` is not installed. There is no auth
  layer to migrate, which is the cost that would normally make this change unattractive.
- **Every page that matters is behind a login.** The wizard (W1–W7b), the dashboard (D1–D8) and the
  whole admin console are authenticated. Server rendering buys SEO and first-paint-with-data; neither
  applies to a screen you cannot see until you have a token.
- **The API is unaffected either way.** It verifies a JWT against JWKS and reads `X-Workspace-Id`.
  It cannot tell whether the token came from a server session cookie or a browser SDK.

## Decision

**Static export to a private S3 bucket, served by CloudFront over an ACM certificate.**

| Piece | Role |
| --- | --- |
| **S3** | Holds the compiled Next.js static export. Bucket is private — *Block all public access* ON. One bucket per app per environment |
| **CloudFront** | CDN and HTTPS termination. Reads S3 through **OAC** (Origin Access Control), which is why hitting the S3 URL directly returns `Access Denied` |
| **ACM** | TLS certificate, requested in **us-east-1** even though the rest of the account is `ca-central-1` — CloudFront reads certificates only from N. Virginia |

Both apps build with `output: 'export'`. Auth moves to `@auth0/auth0-spa-js` (Authorization Code +
PKCE), and the two Auth0 applications change type from *Regular Web Application* to *Single Page
Application*.

### Implementation notes that are easy to get wrong

- **A private bucket returns 403, not 404,** for a missing key. The SPA fallback must map **both 403
  and 404** to `/index.html` with response code **200**, or every deep link breaks. Alternatively a
  CloudFront Function on viewer-request rewrites `/path` → `/path/index.html`, which is tidier and
  keeps real 404s honest. Set `trailingSlash: true` so the export's directory layout matches.
- **Two cache policies, not one.** `/_next/static/*` is content-hashed →
  `Cache-Control: public, max-age=31536000, immutable`. HTML → `no-cache`, so a deploy is visible at
  once. Deploy is then `aws s3 sync out/ s3://<bucket> --delete` (two passes, one per header set)
  plus `aws cloudfront create-invalidation --paths "/*"`.
- **`NEXT_PUBLIC_*` is baked at build time.** Staging and production are separate builds, not the
  same artifact promoted. Nothing secret may ever go in one.
- **`images: { unoptimized: true }`** — there is no image optimiser in an export.
- **ACM lives in us-east-1; Caddy does not use ACM at all.** `api.<domain>` on EC2 keeps getting its
  own certificate from Let's Encrypt via Caddy. Only the two CloudFront distributions need ACM.
- **No client secret reaches the browser.** PKCE has none, so `AUTH0_CLIENT_SECRET` and
  `AUTH0_SECRET` leave the frontend's environment entirely.

## Alternatives considered

**Amplify Hosting** (ADR 0005). Works, and gives branch previews and managed SSR. Rejected now that
the premise behind it is gone: it is the largest third-party grant in the AWS account (a GitHub App
with repo access), adds two IAM roles and a second deploy pipeline, and its Next.js adapter trails
Next releases. We would be paying that for a server we do not need.

**Next.js as containers on the EC2 box behind Caddy.** The recommendation in the previous revision of
`docs/architecture.md` §17.5, written when the auth layer was assumed to exist. Still sound — one
deploy path, no new AWS services — but it puts SSR on the same instance as the API and the worker,
including the inbound-authorisation path with its 300 ms p95 budget. Static files on a CDN contend
for nothing.

**OpenNext / SST on Lambda@Edge.** A third deployment framework and Lambda cold starts on the SSR
path, for two apps at internal scale. No.

## Consequences

- `infra/amplify/` is not created. ADR 0005's `amplify.web.yml` / `amplify.admin.yml` (D8) are
  replaced by an `aws s3 sync` step in the existing GitHub Actions workflow.
- **IAM shrinks.** The `amplify-build` and `amplify-service` roles and the `amplify:StartJob`
  statement disappear. The `ci` user gains `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on the
  four buckets and `cloudfront:CreateInvalidation` on the two distributions. The account is one user
  and one instance role.
- **Two Auth0 changes:** application type Regular Web App → SPA in both tenants, and the callback /
  logout URL lists point at the CloudFront domains. The Actions, the audiences, the two-tenant split
  and the `https://portal/mfa` assertion are all unchanged.
- **`@portal/api-client` becomes the only data path.** With no server components fetching data, every
  screen goes through the typed fetch wrapper and TanStack Query. This was already the plan for
  client components; it now applies uniformly, which is simpler to reason about.
- **Lost: branch preview URLs.** Approximate with a per-branch S3 prefix behind one extra
  distribution if it is ever missed. For one developer it is not missed.
- **Lost: server-side redirect for an unauthenticated visitor.** The app paints a shell, the SDK
  resolves, and it redirects. Behind a login screen this is invisible in practice.
- **Region.** The account moves to `ca-central-1`, which couples to open decision 2 (merchant of
  record, Metacognixion Canada vs Gritbyte India). If Canadian data residency is the driver, **Neon's
  region must match** — CloudFront is global and ACM is us-east-1 regardless, but the database is
  where residency actually bites. `.env.example` still says `AWS_REGION=us-east-1`; change it with
  the account.
- **Cost** drops from Amplify build minutes plus hosting to a few dollars a month. Not the reason for
  the decision, but worth recording.
- Reversible. If a genuine SSR need appears (public marketing pages, per-user SEO), the apps are
  still Next.js — drop `output: 'export'` and take Amplify or containers then.
