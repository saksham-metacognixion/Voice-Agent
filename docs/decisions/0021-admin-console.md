# ADR 0021 — The admin console: staff API, audit, pricing publish with Stripe sync, read-only view-as (D12)

- Status: accepted
- Date: 2026-09-28
- Deciders: Saksham (implementation), Pramod (spec owner)

## Context

D12 (`docs/plan/tasks.csv`) is "everything staff need to run the business without touching the
database": the admin spec's SA1 KPIs, SA2 customers and the 360, SA3 users, SA5 pricing with
Stripe sync, SA7/SA8 numbers and calls, SA12 jobs / webhooks / flags / kill switches, SA14 audit,
the cmd-K search, the health strip, and view-as impersonation (admin §2, §3, §4, §5, §7.4, §9,
§10). The staff auth boundary (two Auth0 tenants, MFA claim, `/admin/*` verified against the
staff JWKS only) existed since D1; nothing behind it did. The admin app was a scaffold.

Four questions had no answer in the spec and needed one:

1. How does "View as (read-only)" work when the portal only knows Auth0 customer tokens and a
   staff JWT must never verify on a customer route (admin §7.4 says "a staff session flagged
   `impersonate=view`", nothing more)?
2. What does "do not mark pricing published if the Stripe sync fails" mean for a versions table
   that only ever inserts (admin §5.2 step 3, ADR 0010)?
3. How is a failed job retried from the console when the BullMQ payload was never stored?
4. Where do the SA3 user actions (verify email, reset MFA, lock, force logout) actually happen?

## Decision

### 1. One `admin` module, on `adminDb`, in front of the same services

`backend/api/src/modules/admin` is the top of the module graph: it imports wallet, runtime-cache,
billing, webhooks, config, agents, events and calls, and nothing imports it. Reads cross
workspaces on `adminDb` (the "legitimately crosses workspaces" case of ADR 0006). Writes go
through the service the customer path uses — `WalletService.withWallet` for credits,
`RuntimeCacheService.refresh` after every pause, `PlatformConfigService.setKillSwitch`,
`WebhookProcessingService`, `JobQueues` — and never through a second implementation.

Routes are thin (`admin.controllers.ts`: parse, delegate, return). `@StaffRoles(...)` is the
admin §2.2 matrix per route; the finer limits live in `StaffLimitsService`, which reads
`staff_role_limits` on every write and answers `403 STAFF_LIMIT_EXCEEDED` naming the role that
could (admin §10). Support may pause a workspace only against a ticket, as the seed comments say.

Every customer-affecting write is audited twice: a `staff_audit_log` row (`StaffAuditService`:
staff, action `<area>.<verb>`, target, workspace, reason code, note, before/after with
secret-looking keys redacted, IP, impersonation id, and the Fastify request id — a new column)
written **inside the same transaction** as the change, and the workspace's own `audit_log` row
with `actor_user_id = NULL` and `meta.by = 'staff'`, so D6's Audit tab shows "paused by support"
as well. An unauditable write is a write that did not happen.

The contract is `shared/schemas/src/admin.ts` plus manifest entries with a new `staffRoles`
field; `discover.ts` reads `@StaffRoles` from the handler or the class, the generator emits
`x-staff-roles`, `x-auth: staff` and a `staffAuth` security scheme, and `openapi:check` refuses a
mismatch like it does for `@Roles`.

### 2. View-as is an API-minted credential, not an Auth0 token

`POST /admin/customers/:id/impersonate` creates an `impersonation_sessions` row (mode `view`,
one hour, one open session per staff member and workspace, reused on a second click) and answers
a portal link: `${PORTAL_URL}/impersonate/#session=<id>&key=imp_<payload>.<hmac>`. The key is an
HMAC over `(session, tenant, staff, exp)` from `ImpersonationTokenService`
(`IMPERSONATION_SIGNING_SECRET`, falling back to `RECORDING_SIGNING_SECRET`). It travels in the
**fragment**, not the query string (review, 28 Sep): the portal is S3 + CloudFront, whose access
logs record the full query string of every request, and the key is a bearer credential good for an
hour of customer reads. A fragment never leaves the browser. Because the portal keeps the key in
the tab's sessionStorage, the console banner cannot link to the portal by origin alone once that
tab is closed; `POST /admin/impersonations/:id/open` re-mints the link for the session's own staff
member and is audited (`impersonation.reopened`).

On the customer namespace, `AuthGuard` recognises the `imp_` prefix before any JWKS lookup, reads
the session row on every request (an ended session is refused at once, not at the HMAC's expiry)
and makes the request look like the workspace **owner** (`ctx.userId` is the owner's, because D5–D7
read "my" settings by it), with `request.impersonation` set. `WorkspaceGuard` then pins
`ctx.workspaceId` to the session's tenant (a header naming another of the owner's workspaces is
`NOT_A_MEMBER`), refuses every non-GET with `403 IMPERSONATION_READ_ONLY`, and refuses
`/calls/:id/recording` (recording access is a logged, ticketed action, admin §10). The one write a
session may make is `POST /impersonation/end` (`@AllowImpersonationWrite()`), the portal banner's
Exit. `GET /workspaces` under impersonation returns only the impersonated workspace.

On the portal, `/impersonate/` stores `{session, key, expires}` in **sessionStorage** (dies with
the tab), `AuthProvider` reports an authenticated session whose token is the key without touching
Auth0, `ImpersonationBanner` (mounted in `Providers`, so it sits above the wizard and the auth
pages too) reads `GET /impersonation` and offers Exit, and a 401 under impersonation sends the
tab to `/login`. The console shows its own banner from `GET /admin/me` (`impersonations`) with an
Exit that calls `DELETE /admin/impersonations/:id`. Both ends write `impersonation.ended` with
`ended_via ∈ {admin, portal}`. Act-as (writes under a customer's identity, admin §7.4) is P2 and
has no code path: the request schema accepts only `view`.

### 3. A pricing version is inserted unpublished, synced, then made effective

`POST /admin/pricing/publish`: the draft is parsed, the preview's blockers are re-evaluated (a
pack bought in the last 12 months cannot be removed — `CONFLICT`; a tier under the margin floor
from `retell_cost_inputs` is `422 MARGIN_FLOOR` unless `override_margin` with a note), then a
`pricing_configs` row is created with `effective_at = NULL` and `stripe_sync_json = pending`.
`PlatformConfigService.loadCurrentPricing()` only ever serves `effective_at ≤ now`, so the row is
invisible. `StripePriceSyncService.sync()` runs the pure `planPriceSync()` (reuse a Price whose
amount and currency did not change, create a Price — and a Product keyed by `pack_id` metadata
when none exists — for a new or re-priced pack, archive a Price no longer sold), look-before-you-buy
on Stripe lookup keys `<env>_pack_<id>_<currency>_v<version>` (the environment, because dev and staging share one test account; a key whose Price sells another amount is taken over with `transfer_lookup_key`, never reused), persisting each `stripe_price_map` row as
Stripe answers. A failure leaves the row with the error in `stripe_sync_json`, writes
`pricing.publish_failed`, keeps the draft and answers `503 STRIPE_SYNC_FAILED`; publishing again
finds the pending version with the same config and **resumes** it. Success sets `effective_at`,
`published_by`, the summary and the grandfather mode in one transaction with the draft's deletion
and the audit row, then `invalidateAll()` drops `pricing:current`, `stack:current`, `flags:*`,
`caps:*` — the next `GET /pricing` is the new version, and the 60 s TTL bounds a missed drop
(admin §5.3, the D12 SLA). `grandfather_mode = apply_now` updates every tenant's denormalised
caps from its tier's largest pack (admin §5.2 step 6). Rollback inserts a new version carrying the
target's config and copies its Stripe rows; history is never rewritten. A keyless dev box records
`skipped`, never `synced`, and checkout keeps falling back to inline price data.

### 4. Jobs keep their payload; SA3 goes through the Management API

`jobs.payload_json` (new column) is written by the two enqueue sites (`PromptingService`,
`ActivationService`) before `add()`. Retry re-opens the row (the partial unique index refuses it
when the customer already has a newer job in flight), re-enqueues the stored payload under the same
deterministic BullMQ id (`JobQueues.add(..., verify)` replaces the spent failed job), and fails
loudly if the queue does not answer. Discard removes whatever the queue holds unless it is
`active`, and writes the row off with a customer-safe reason.

`Auth0ManagementService` (auth module, client credentials from `AUTH0_CUSTOMER_M2M_*`) does verify
email, reset MFA (delete authenticators), block/unblock and revoke sessions + refresh tokens. Our
row changes too — `users.locked_at` (new column) is what `AuthGuard` refuses with
`403 ACCOUNT_LOCKED`, so a lock holds through a provider outage and against a token minted before
it. Unconfigured (dev, CI, the local issuer) answers `provider: skipped`, never a silent success.

### 5. The rest, briefly

- KPIs (`AdminKpisService`) are computed in Postgres from the definitions in Appendix A; live
  concurrency is read from the same `active:*` hashes the inbound checks use, and
  `CONCURRENCY_PLATFORM_LIMIT` is the allowance. Recognised revenue and COGS in dollars wait for P2.
- The customers list computes status and balance in memory over at most 500 tenants (balances
  from the newest ledger row per tenant), so it pages by offset cursor and returns `total`.
- Search is one bounded query per entity; ids match only on a full uuid (Prisma has no prefix
  match on `@db.Uuid`).
- The health strip caches each provider probe (Retell `list-voices`, Stripe `balance.retrieve`)
  for a minute in Redis and never returns a hostname or key.
- The local issuer has a staff mode (`pnpm dev:issuer:staff`, port 9998) that stamps
  `https://portal/mfa: true`, and `pnpm db:seed` creates the matching `staff_users` row on a dev box.
- The admin app (`frontend/admin`) is a static export like the portal, English only (no next-intl),
  every mutation behind a reason-code dialog, permission-aware from `GET /admin/me`.

### 6. What the manual QA pass changed (28 Sep)

A browser-and-API QA pass against a local stack (both stand-in issuers, the compiled API and
worker, both exports, the real Stripe test account) found four defects, fixed here:

- **Force logout did not end a live session.** Revoking at the provider stops new tokens; an
  access token already in a browser stayed valid for its hour, and a dev box has no provider at
  all. `users.sessions_revoked_at` (set by force logout and by lock) makes `AuthGuard` refuse any
  token issued before it (`iat` < the revocation second — strict, so a sign-in right after an
  unlock is never refused). The portal signs out on a 401 instead of showing errors.
- **A ticket number broke credit adjustments (500).** `credit_adjustments.ticket_id` references
  `support_tickets`, which stays empty until SA4 (P2). The ticket is now linked only when it
  exists; otherwise the number is kept in the audit row (`ticket_id`, `ticket_linked: false`).
- **A double submission credited twice.** The dialog disabled its button, but a second tab or a
  retried request moved credits again. `idempotency_key` (a uuid the console makes per opened
  dialog) becomes the adjustment id: a repeat answers the first adjustment, and two racing
  requests collide on the primary key inside the wallet transaction, rolling the second ledger
  row back with it. A key reused on another workspace is `409`.
- **Stripe lookup keys collided across environments.** Dev and staging share one test account;
  keys are now `<env>_pack_<id>_<currency>_v<n>`, Products are searched by `pack_id` *and* `env`,
  and a Price found under a key is reused only when it sells the same amount, currency and
  Product — otherwise a new Price takes the key over (`transfer_lookup_key`).

### 7. SA3 against the real tenant, and force-logout order (28 Sep)

Run against the real customer dev tenant with a throwaway user signed in through the real
Universal Login: verify email, lock (Auth0 `blocked`, silent sign-in refused, API `ACCOUNT_LOCKED`),
unlock, reset MFA and force logout (Auth0 session gone — silent sign-in answers `login_required`,
the API refuses the token already in the browser, the open tab signs out) all applied at Auth0 and
were audited with `provider: applied`. The M2M app needed three more client-access scopes
(runbook §1). Force logout now revokes **locally first**; an identity-provider failure answers
`200 {provider: 'failed', provider_error}` instead of a 503 that undid nothing — the API side of
the logout always holds. Expired tokens were checked on the live stack with 5-second tokens
(`LOCAL_ISSUER_TTL_S`): both namespaces answer 401, both SPAs refresh silently, and a refused
refresh sends the person to sign in.

**Drift found and fixed the same day:** the live customer dev tenant's Portal API had
`allow_offline_access: false` while `infra/auth0/tenant.customer.yaml` says `true`, so the portal
received no refresh tokens and relied on iframe silent auth, which browsers blocking third-party
cookies break. Turned on in the dashboard 28 Sep; the rerun confirmed the portal now receives a
refresh token and that lock and force logout make Auth0 refuse it (`invalid_grant`). Staging and
prod tenants were not checked.

## Consequences

- Tests: `backend/api/test/d12-admin.e2e.test.ts` (26 cases): the staff boundary incl. the MFA
  claim, the §2.2 matrix and the role limits; credits through the wallet with the record and the
  audit row; tenant/agent/number pause visible to the customer API; user lock refused by
  `AuthGuard`; job retry/discard; webhook replay idempotent; flags and kill switches with
  `kill:reject_inbound` projected; pricing publish with a failed then resumed Stripe sync,
  `GET /pricing` on the new version at once, rollback; impersonation reads, every write refused,
  end from both sides; the audit log.
- Every `/admin/*` mutation carries a `staffActionRequest` (`reason_code`, note required for
  `other`, optional ticket). There is no admin write without a reason.
- `POST /impersonation/end` is the only mutating route reachable with an impersonation credential.
  Adding another needs `@AllowImpersonationWrite()` and a sentence here.
- Staff view-as sees a workspace exactly as its owner does, minus recordings and minus every button
  that writes. A workspace still in the wizard opens on its current step and the autosave fails
  read-only; the banner says why.
- Not in D12: notes and flags editing, tickets (SA4), refunds (SA9), overrides (`PUT
  …/overrides`), lot extension, anonymise, number release/resync from the console, recording
  access with a ticket, act-as, staff management (SA13) — P2 per admin §11.

## Addendum, 27 Oct 2026: a webhook event names the workspace it was billed to

QA (ClickUp "Webhook events list shows no Customer for a call that was billed to a
workspace"): on SA12 the three events of a call billed to Bright Smile Dental Clinic showed
"–" under Customer and were missing from that customer's Webhooks tab. The console read the
workspace out of the payload only (`call.metadata.tenant_id`), and a call let through
without metadata — a fail-open, or an event `call-recovery` stored — carries none; billing
finds its workspace through the agent / number fallback (ADR 0011 §2).

- `webhook_events.tenant_id` (nullable, `SET NULL`, indexed with `received_at`), migration
  `20261027180000_webhook_events_tenant`, backfilled from `calls` (Retell), then our
  metadata, then the Stripe customer.
- Written after the handler by `WebhookEventsService.attribute()`, from the queue and from
  an SA12 replay, never failing the event. Retell: the `calls` row's workspace, on every row
  of the call still without one, so a transfer event settled as deferred is named when its
  `call_ended` lands. Stripe: our metadata, else the workspace holding the object's
  customer. Auth events name none.
- The list, the customer filter, the event detail and the replay audit read the column
  first and fall back to the payload (`webhookTenantHint`) for a row not attributed yet; a
  row attributed to one workspace never matches another on its payload.
- Test: `test/d12-admin.e2e.test.ts`, "names the customer a call was billed to when the call
  carried no metadata".
