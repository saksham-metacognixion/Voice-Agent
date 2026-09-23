# ADR 0017 — Portal foundation: session, gating, theme tokens, local issuer

- Status: accepted
- Date: 2026-09-22
- Deciders: Saksham
- Scope: `frontend/web`, `frontend/ui`, `frontend/api-client`, one CORS line in the API, D8 (§6, §7, §8 W1–W3, §12)

## Context

D8 turns the scaffolds into the customer's first three minutes: sign up, describe the
business, hear a voice. Everything ships as a static export to S3 + CloudFront (ADR 0008),
so there is no server to hold a session, redirect an anonymous visitor, or read a dynamic
segment. Auth is Auth0 Universal Login through `@auth0/auth0-spa-js` (ADR 0002 as amended
by 0008). The spec asks for §6.4 onboarding gating, a §7.2 shell, §7.3 design system with
light **and** dark themes, W2 autosave at 1.5 s, and Generate with SSE plus polling.

## Decisions

### 1. Session: the SPA SDK owns it; the app reads claims, never cookies

`AuthProvider` (`src/auth/auth-provider.tsx`) wraps one `Auth0Client` with
`cacheLocation: 'localstorage'` and rotating refresh tokens, so a refresh does not bounce
through Auth0 and the session outlives the access token. The redirect target is the **app
origin** — `callbacks: [PORTAL_URL]` in `infra/auth0/tenant.customer.yaml` — so `/`
handles `?code=&state=` and then goes to `appState.returnTo`.

A3 needs the `email_verified` claim to flip without a new sign-in. `refresh()` calls
`getTokenSilently({cacheMode: 'off'})`, which is a refresh-token grant; Post-Login Actions
run on that grant, so the re-minted tokens carry the new claim. A5 asks for the
`multi-factor` `acr_values` on a fresh sign-in and reads `amr` afterwards; enrolment is
Auth0's page, not ours. A6's first half is Auth0's public `dbconnections/change_password`.

### 2. Gating is one pure function plus four guards

`useSessionGate()` (`src/guards/session-gate.ts`) computes "where does this person belong"
from auth + memberships + the workspace row: anonymous → `/login?next=`, unverified →
`/verify-email`, no workspace → `/setup/workspace`, several and none chosen →
`/select-workspace`, `onboarding_step` ≤ last implemented step → that wizard page, else
`/app`. `RequireAuth`, `RequireVerified`, `RequireWorkspace`, `OnboardingStepGuard(step)`
and `AppGuard` render a loader until the decision is made and never paint protected content
first. A wizard page W-k is reachable while `k ≤ onboarding_step` (revisit yes, skip ahead
no). `LAST_IMPLEMENTED_STEP` in `src/routes.ts` is 3 today: the dashboard opens once the
customer is past W3, W4–W7 are placeholders until D9, and the shell shows a "continue
setup" banner until `onboarding_completed_at` is set.

The step pointer is advanced by the portal (`PATCH /workspace {onboarding_step}`), never
moved backwards, single-flight per step, and a guard **never redirects while the workspace
row is being re-read** — the first run bounced W3 back to W2 because the guard evaluated
against the stale cache a few hundred milliseconds before the advance landed.

### 3. Theme: tokens in `@portal/ui`, `.dark` on `<html>`, no raw colours in components

`frontend/ui/src/styles/globals.css` defines every colour twice (`:root`, `.dark`) and maps
them into Tailwind v4 with `@theme inline`, so `bg-card`, `text-muted-foreground`,
`border-border` follow the active theme. `@custom-variant dark` binds `dark:` to the class,
not the OS. `next-themes` sets the class before first paint and persists `portal-theme` per
browser. Every component in `@portal/ui` (Radix primitives via the `radix-ui` package,
sonner, lucide) uses tokens only, so a new component gets both themes for free and a
palette change is one file. The shared preset keeps only what is theme-neutral (fonts,
radii, the 8-px grid).

The palette is the Oraly brand sheet (`docs/brand.md`): Purple `#7B5CFF` is `--primary` in
**both** themes — the constant that makes them one brand — Soft White and Deep Navy are the
two backgrounds, Slate is the dark elevated surface, and Electric Blue is a graphic colour
whose light-theme text step is darkened because `#22D3EE` on white is 1.7:1. The logo is the
supplied artwork rather than a redraw — the waveform's gradient is diagonal and the wordmark
is a licensed face — extracted from the brand file with its white matte removed into
`public/brand/`. Light and dark differ only in the wordmark's colour, both are in the DOM,
and CSS swaps them, so the right one is showing in the first painted frame.

### 4. The invite link is `/invite/?token=…`

The spec writes `/invite/[token]`; a static export cannot serve an arbitrary segment
without a per-token file. The token moves to the query string. The backend does not send
invite emails yet (D6 returns the token once, for a copyable link); when it does, it builds
`${portalUrl()}/invite/?token=`.

### 5. Data: one client, SSE **and** polling, diff-based autosave

`@portal/api-client` gained `ApiProvider`/`useApi`, `createQueryClient` (no retry on 4xx,
two retries on network/5xx, 30 s stale), `subscribeEvents` over
`@microsoft/fetch-event-source` (token re-read on every reconnect; 401/403 stops the
retry loop), `useWorkspaceEvents`, and `useJobWatch` — `GET /jobs/:id` every 3 s until a
terminal state. Generation runs **both** at once: the server never replays a frame, so the
poll is what guarantees the terminal state is seen; whichever answers first wins. The job
id is kept per agent in localStorage so a refresh mid-generation re-attaches instead of
offering a second Generate; a 409 from the API is treated as "already running".

W2 autosave (`useBriefAutosave`) sends only the top-level brief fields whose JSON changed
since the last successful save, serialises saves (a change during a save is sent after
it), and `flush()` is awaited before Generate so the model reads what is on the screen.

### 6. A local stand-in issuer for dev and the end-to-end run

The Auth0 dev tenant was configured by hand and does not list `http://localhost:3000` as a
callback (Auth0 answers "Callback URL mismatch"); `pnpm auth0:deploy` would fix it but
needs the M2M credentials that are still missing. Rather than block every local run on a
dashboard change, `infra/scripts/local-issuer.mjs` (`pnpm dev:issuer`) is a 100-line OIDC
issuer: `/authorize` answers at once with a code, `/oauth/token` signs RS256 tokens with the
namespaced claims, PKCE is verified, JWKS is served. The API already honours a plaintext
`http://` issuer outside prod (`issuerFor`), and the SPA SDK accepts a domain with its own
scheme, so no code path is bypassed: the real guard, the real JWKS fetch, the real claims.
It is refused by the API in prod and is never configured in staging.

`frontend/web/scripts/e2e-wizard.mjs` drives the whole D8 exit check through headless
Chrome over the DevTools protocol (no browser-automation dependency): 36 assertions from
sign-up to the dashboard, including a real Generate. It found the two bugs below.

### 7. Two backend facts the run surfaced

- The API's CORS preflight did not list `PATCH`, so the wizard could never autosave or
  advance a step from a browser. `main.ts` now names the methods (and `Last-Event-ID`).
- `GET /voices?lang=en` returns the whole catalogue (302 rows): the voices are tagged
  multilingual. The picker pages 24 at a time with the chosen voice pinned first.

### 8. Analytics and copy

PostHog is off without a key; identity is the Auth0 `sub`; events carry ids, step names
and counts, never brief text, emails or numbers (`src/analytics/posthog.tsx` lists the
catalogue: signup, workspace_created, template_selected, brief_field_saved,
brief_completed, generate_clicked, generation_started/completed/failed, voice_selected,
language_selected, voice_preview_played, onboarding_step_viewed/completed…). Copy is
`next-intl` with a client provider and one `en.json`; there is no locale routing, and
fr-CA is a second file when P2 asks for it.

## Staging

`infra/aws/frontend-stack.yaml` (private S3 + OAC + CloudFront + the index-rewrite
function + cache and security-header policies + the CI deploy policy),
`infra/scripts/deploy-frontend.sh` (two `s3 sync` passes, invalidation, refuses a
localhost API URL) and the `deploy-portal-staging` CI job. **Not deployed:** the AWS
account has no stack yet (ADR 0015/0016 state), and the Auth0 tenant needs
`https://app-staging.oraly.ai` as a callback. The runbook has the steps.

## Consequences

- Any new screen composes the guards and reads tokens; none needs theme logic or its own
  fetch code.
- `pnpm --filter @portal/web e2e:wizard` is the D8 regression check; it needs Chrome, the
  local issuer, and a build pointed at it.
- The D9 work bumps `LAST_IMPLEMENTED_STEP` as W4–W7 land.
