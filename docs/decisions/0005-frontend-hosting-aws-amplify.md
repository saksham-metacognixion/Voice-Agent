# ADR 0005 — Frontend hosting: AWS Amplify Hosting (CloudFront)

- Status: accepted
- Date: 2026-09-11
- Deciders: Saksham, Prateek
- Supersedes: the frontend half of the Hosting row in [ADR 0001](0001-tech-stack.md) (Vercel). Backend hosting is [ADR 0004](0004-backend-hosting-aws-ec2.md).

## Context

With the backend on AWS EC2 (ADR 0004) the team wants the two Next.js apps served from CloudFront as well,
so the whole platform lives in one AWS account. Both apps need full Next.js server features: the Auth0
SDK relies on middleware and route handlers for login, callback and session refresh, and the wizard and
dashboard render per-user data server-side.

## Decision

**AWS Amplify Hosting, one app per Next.js project** (`frontend/web` → `app.<domain>`,
`frontend/admin` → `admin.<domain>`). Amplify Hosting is CloudFront plus managed SSR compute, connected to
the GitHub repo: a push to `main` builds and deploys, every branch gets a preview URL.

| Concern           | Choice                                                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework support | Next.js 15 App Router, middleware, route handlers, ISR all supported by Amplify's Next.js SSR adapter                                                                                               |
| Monorepo          | `amplify.yml` per app with `applications[].appRoot` pointing at `frontend/web` / `frontend/admin`; build command `pnpm install --frozen-lockfile && pnpm turbo run build --filter=@portal/<app>...` |
| Environments      | `main` → production, `staging` branch → staging, feature branches → previews                                                                                                                        |
| Domains and TLS   | Amplify custom domains with ACM certificates; CloudFront in front by default                                                                                                                        |
| Env vars          | Amplify app environment variables for `NEXT_PUBLIC_*`; server-side secrets (`AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`) via SSM Parameter Store references                                               |
| Headers and CSP   | `next.config.ts` `headers()`; the admin app adds a strict CSP and `X-Frame-Options: DENY`                                                                                                           |
| API traffic       | The apps call `api.<domain>` on EC2 directly (ADR 0004). Webhooks and SSE never touch Amplify.                                                                                                      |

## Alternatives considered

**Vercel** (ADR 0001). The best Next.js developer experience, but a second vendor when everything else is
on AWS. Set aside by team decision.

**Next.js containers on the EC2 compose stack behind a CloudFront distribution.** One deploy path and the
cheapest option, and a reasonable fallback if Amplify's Next.js adapter lags a Next release. Rejected for
MVP because it costs about a day of CloudFront origin, cache-key and invalidation setup, removes preview
deploys, and puts frontend load on the same instance as the sub-300 ms webhook path.

**S3 static export + CloudFront.** Rejected: `output: 'export'` disables middleware and route handlers, so
Auth0 login cannot run, and every per-user screen would have to move to client-side fetching.

**OpenNext / SST on Lambda + CloudFront.** Full control and full Next.js support, but a CDK/SST stack to
own. Right choice if Amplify becomes limiting; not for a three-week MVP.

## Consequences

- Two Amplify apps to create on D1 and connect to the GitHub repo; the repo must be pushed first.
- Amplify builds run on Amplify's runners, not GitHub Actions. CI still lints, typechecks and tests on
  GitHub; Amplify only builds and deploys. Keep the build command identical so both agree.
- Cold starts on SSR routes after idle are possible on Amplify compute. Acceptable for the portal; the
  latency-critical paths are all on the API.
- Cost: build minutes plus per-GB served plus SSR request duration. Expect single-digit dollars per month
  at launch scale.
- Preview URLs are on `amplifyapp.com`; Auth0 allowed callback URLs must include the preview pattern for
  the dev tenant, but never for production tenants.
