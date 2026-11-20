# 0025 — Production hardening for the D14 gate

Date: 29 Sep 2026. Status: accepted. Spec: §6.2 (CSRF, rate limiting, disposable email),
§17 (fraud, backups), §18, CLAUDE.md "Observability". Builds on ADR 0002 (Auth0), ADR 0003
§12 (Redis down), ADR 0014 (ops alerts), ADR 0016 (RDS).

## Context

The D14 brief is a production-readiness gate. Five of its exit criteria had no code behind
them on 29 Sep: disposable-email blocking, API rate limits, CSRF / origin protection,
Sentry, and OpenTelemetry traces. The spec names the first three (§6.2: "CSRF: SameSite
cookie + origin check on state-changing requests. Rate limiting: login 5 failures / 15 min
per email+IP, then CAPTCHA; sign-up 3 / hour / IP … Disposable email domains blocked at
sign-up (open-source list). Free-mail domains allowed"), CLAUDE.md names the other two. The
brief also names a Neon PITR drill; ADR 0016 replaced Neon with RDS.

## Decision

1. **Disposable email, twice.** A blocking Auth0 **pre-user-registration** Action
   (`customer-pre-registration`) denies the sign-up before the account exists, with the
   customer-facing sentence on Universal Login. `UsersService.upsert` refuses to create a
   `users` row for such an address on every path that makes one (registration webhook,
   login webhook, the guard's JIT provisioning): the webhook settles the event as
   `refused: disposable_email`, the guard answers `403 EMAIL_DISPOSABLE`. Existing rows are
   never refused, so a domain joining the list later locks nobody out. The list is
   `disposable-email-domains-js` (CC0, the community blocklist, 8 883 domains, updated
   21 Sep 2026), pinned to the same exact version in `backend/api/package.json` and the
   Action's `dependencies`; a subdomain of a listed domain is refused too.
   `disposable-email.test.ts` runs the Action file and fails when the two versions drift.
   The older `disposable-email-domains` package (121 k entries, last published 2022) was
   rejected for staleness and false-positive risk.
2. **Auth0 attack protection is the login and sign-up limit.** Brute force at 5 failures
   per email + IP; suspicious-IP throttling's pre-user-registration stage at 3 attempts
   regained one per 20 minutes (= 3 / hour / IP). Two differences from §6.2, recorded:
   Auth0's brute-force block lifts on a password reset or from the dashboard, not after 15
   minutes, and the CAPTCHA step is Bot Detection, an add-on the tenant's plan does not
   include.
3. **One `onRequest` hook for the origin check and the API budget**
   (`common/http/request-limits.ts`), before routing, body parsing and JWT verification:
   - a POST / PUT / PATCH / DELETE whose `Origin` is not the portal's or the console's is
     `403 ORIGIN_NOT_ALLOWED`. No `Origin` (a server, a provider) is left to
     authentication. Auth is a bearer header, never a cookie, so this is the second fence,
     not the first;
   - a fixed one-minute window per client IP, `API_RATE_LIMIT_PER_MIN` (default 600, 0 =
     off), answers `429 RATE_LIMITED` with `Retry-After` and the CORS headers (without
     them the browser reports a network error). `request.ip` is trustworthy because Caddy
     trusts `X-Forwarded-For` only from private ranges. Redis silent past 50 ms = allow;
   - never applied to `/webhooks/*` (the §13.9 hot path and provider retries) or
     `/health*`.
4. **OpenTelemetry owns traces, Sentry owns errors.** `src/observability` is the first
   import of `main.ts` and `worker.ts`. Traces go to `OTEL_EXPORTER_OTLP_ENDPOINT`
   (Grafana Cloud) with HTTP, undici (Retell / Stripe / Anthropic / Auth0), ioredis, Nest
   and Prisma instrumentation, plus one span per BullMQ job (`job <queue>/<name>`), which
   no instrumentation sees. Health probes and query strings are not recorded, nor Redis
   argument values. Sentry 11 installs no tracer provider of its own, so the two do not
   compete; every Sentry event carries the OTel `trace_id` tag. Sentry runs **errors
   only**: `dataCollection` off for bodies, cookies, query strings, user info, database
   and queue data and frame variables; credential headers blanked in `beforeSend` as a
   backstop; and only nine of its default integrations (no HTTP / framework
   instrumentation, no session tracking). The exception filter reports what it logs as a
   bug (5xx); the worker reports a job's **final** failed attempt. Both are off unless
   `SENTRY_DSN` / the OTLP endpoint are set. Browser errors: `@portal/ui/error-reporting`
   in both apps (`NEXT_PUBLIC_SENTRY_DSN`), with query strings and fragments stripped from
   every URL — `/invite/?token=` and `/impersonate/#key=` are credentials — and no DOM or
   console breadcrumbs.
5. **Diagnostics from the console**: `POST /admin/system/test-error` (a real throw through
   the filter, always 500) and `POST /admin/system/test-alert` (one `diagnostics_test` ops
   alert through every sink, answering what each said) — super admin and ops. They are how
   the D14 "trigger it and see it arrive" checks are run on staging. `OpsAlertService.send`
   now resolves with the per-sink outcome.
6. **The DR drill is an RDS point-in-time restore into a throwaway instance**
   (`docs/runbooks/pitr-drill.md`), compared with `diff` against a fingerprint of the live
   database at the same cut-off (`infra/scripts/pitr-fingerprint.sh`): rows per
   never-deleted table, every workspace's ledger balance, orphans, migrations, RLS, the
   policy count, the append-only triggers and the roles; then the app role connects with
   RLS enforced, and the copy is deleted.
7. **The console deploys like the portal**: CI job `deploy-admin-staging`, gated on the
   repository variable `STAGING_ADMIN_BUCKET`, built against the staff tenant.

## Measured

k6 `test/load/inbound.k6.js`, 40 VUs, laptop, same build, 29 Sep 2026:

| Configuration                          | req/s | p95     |
| -------------------------------------- | ----- | ------- |
| Nothing on                             | 6 812 | 7.9 ms  |
| Sentry, default integrations           | 2 743 | 20.5 ms |
| Sentry, the nine kept (shipped)        | 6 048 | 9.0 ms  |
| Sentry (kept) + OTel, 100 % sampled    | 3 799 | 14.8 ms |
| Sentry (kept) + OTel, 10 % sampled     | 4 271 | 12.9 ms |

The SLO is p95 < 300 ms; every row passes by an order of magnitude. OpenTelemetry's cost is
the instrumentation, not the export (sampling recovers little), so full sampling ships and
`OTEL_TRACES_SAMPLER=parentbased_traceidratio` + `OTEL_TRACES_SAMPLER_ARG` is the knob if
the instance ever needs the headroom.

## Alternatives considered

- **`@fastify/rate-limit`** — a second Redis client and a plugin whose hook order against
  `@fastify/cors` Nest does not let us control; one INCR in a hook we own is less.
- **Sentry performance tracing instead of OTel** — Grafana Cloud is the named trace
  backend, and Sentry's instrumentation was the costliest configuration measured.
- **Rejecting disposable addresses only in the API** — the account would still exist in
  Auth0, verified, able to sign in to nothing. The Action stops it at the door; the API
  covers a tenant where the Action was never deployed.

## Consequences

- New error codes `EMAIL_DISPOSABLE` and `ORIGIN_NOT_ALLOWED` (403), with portal copy.
- Staging needs, in SSM: `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_EXPORTER_OTLP_HEADERS`, `OPS_ALERT_WEBHOOK_URL` (Slack); optionally
  `API_RATE_LIMIT_PER_MIN`. Repository variables `STAGING_PORTAL_SENTRY_DSN`,
  `STAGING_ADMIN_SENTRY_DSN` and the `STAGING_ADMIN_*` / `STAGING_STAFF_AUTH0_*` set. The
  customer tenant needs `pnpm auth0:deploy customer` for the Action and the throttling.
- A Nest `@Post` answers 201; the diagnostics routes follow the house default.

## Addendum — staging validation, 30 Sep 2026

Run against staging (`api-staging.oraly.ai`, image `sha-d138dd6`) and the local stack.

- **Origin and budget, live.** A POST with a foreign `Origin` is `403 ORIGIN_NOT_ALLOWED`; a
  webhook route with the same header is not refused. 620 requests from one IP inside one
  minute: exactly 600 answered, 20 were `429 RATE_LIMITED` with `Retry-After` and the CORS
  headers. `/health` stays exempt.
- **Slack.** `OPS_ALERT_WEBHOOK_URL` is a Slack incoming webhook to the operator's own DM;
  the console's test alert arrived. Sentry issues are not routed to Slack (email only).
- **Redis down.** `docker stop` of the staging Redis for 24 s: signed inbound requests kept
  answering `200 {}` in < 100 ms, `/health/ready` went 503 while `/health` stayed 200, API
  and worker reconnected by themselves, heartbeat and all 14 schedulers came back. **Finding,
  fixed:** the inbound fail-open only wrote a log line — nobody was told. It now raises a
  `redis_down` ops alert (critical, once per outage minute, on its own clock so the
  unknown-number log throttle cannot swallow it; not awaited, and it posts over HTTP, so it
  reaches a human while Redis is what is down). `test/calls.e2e.test.ts` pins it.
- **Rental.** Three `d7-recurring` rental tests failed on 30 Sep: the fixture's "30 days
  ago" is 31 Aug, whose next anniversary clamps to 30 Sep — due again. A test bug (it fails
  on every day whose previous month is short); the fixture is now "due yesterday". The
  clamp itself drifts an anniversary for good (31 Jan → 28 Feb → 28 Mar) — a product
  finding, left for the owner.
- **WCAG 2.1 AA.** axe-core (wcag2a/aa, 21a/aa) over every portal and console screen, light
  and dark, 1440 and 390 px: 148 page views. Before: white on brand purple 4.36:1, purple
  text on its own tint 3.4, success green as text 2.63–3.29, sliders with no name on the
  thumb, and the W3 voice list a `listbox` whose options held buttons. After: 148/148 clean.
  `--primary` is `#7050F5` in light and `#9580FF` with Deep Navy text in dark — shades of
  the brand purple, not a new colour; `text-success-emphasis` joins
  `text-warning-emphasis`; tinted-purple text is `text-accent-foreground`; `Slider` puts
  `aria-label` on the thumb; the voice list is a list of cards whose choose button carries
  `aria-pressed` (`data-testid="voice-card"`). A keyboard pass found that
  `:focus-visible { outline: none }` in the base layer left nav links, the balance pill and
  tabs with no focus indicator (2.4.7); the base rule is now a 2 px `--ring` outline, which
  a component's own `outline-none` still overrides.
