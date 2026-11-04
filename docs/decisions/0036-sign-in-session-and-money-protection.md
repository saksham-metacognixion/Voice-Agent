# 0036 — Sign-in, sessions, MFA and money protection (§6.2, §6.3, §17)

Date: 3 Nov 2026. Status: **accepted** for the implementation (§1–§10). **4 Nov:** the
spec is binding, so §8's CAPTCHA, A2's code, §11, §12, §13 and §5's reset-link TTL are
**open spec requirements, not retirements** — see "Open spec requirements" below; the
15-minute block expiry in §8 is built. Amends ADR 0002 (the sign-in
methods table), ADR 0017 §1 (the A2 screen), ADR 0025 §2 (login limits) and ADR 0033 §8 (the
"2 h" sign-out window). Spec: §6.2, §6.3 A1–A8, §6.4, §17. Audit rows A-07…A-36 and SEC-10
of `docs/audits/voice-agent-portal-phase-audit.md`.

## Context

The 29 Oct audit left the auth and money-protection rows of §6.2, §6.3 and §17 open ahead of
D15 (production cutover): the MFA rule for money at risk was seeded and read nowhere (A-12),
the first-purchase review was seeded and read nowhere (SEC-10), the backend token lived 2 h
against a 15-minute spec (A-14), sign-ins and purchases were not in the workspace audit log
(A-22), the Terms checkbox was never stored (A-24), A2 had no resend (A-25), remember-device
was off (A-29), the invitee's address was not pre-filled (A-34), the switcher had no balance
(A-32), and magic link and Microsoft had neither code nor an ADR (A-07, A-09).

Two facts shape every decision below:

- **Sign-in is Auth0 Universal Login** (ADR 0002, 0017). Our API never sees a password, a
  failed attempt, an MFA code or a magic link. Anything about those is either Auth0
  configuration (`infra/auth0/tenant.customer.yaml`, the Actions) or something Auth0 tells us
  afterwards (an Action, the tenant log stream). Building a second sign-in path to own those
  decisions would be the hand-rolled auth §6.2 forbids.
- **The portal is a static SPA with bearer tokens** (ADR 0008), not a cookie session.

## Decision

### 1. A backend token lives at most 15 minutes (A-14), sessions slide for 30 days (A-13)

- The Portal API resource server mints access tokens for 900 s (`token_lifetime_for_web`,
  `token_lifetime`). The SPA renews through its rotating refresh token, so the cost is one
  silent token call per quarter hour.
- **The API enforces it whatever the tenant says**: `JwtVerifier` refuses a customer token
  whose `iat` is older than `AUTH_CUSTOMER_MAX_TOKEN_AGE_S` (default 900, `0` = off for a
  stand-in issuer, anything unreadable refuses to boot) with `401 TOKEN_EXPIRED`. The api
  client answers that one code by asking for a fresh token (`getTokenSilently({cacheMode:
  'off'})`) and retrying once; the SSE client does the same on its first 401. Any other 401,
  or a second `TOKEN_EXPIRED`, signs out as before. Staff tokens are not age-checked here.
- Refresh tokens: 30 days idle (the "sliding" part), 90 days absolute, rotating. The §6.2
  "HttpOnly cookie" stays replaced by the SPA's refresh token (ADR 0008); revocable per device
  through `GET/DELETE /sessions` (ADR 0033 §8).
- The local issuer mints 15-minute tokens by default.

### 2. MFA is required of owners and admins while money is at risk (A-12)

- **The rule** is `mfaRequiredFor(role, {balance, autoTopupEnabled, threshold})` in
  `@portal/schemas`: owner or admin, and auto top-up on or balance strictly over
  `wallet_policy.mfa_required_above_balance` (1,000, from the published pricing config —
  staff-only to change, SA6). Editors and viewers are never asked.
- **"Passed a second factor"** is the `https://portal/mfa` access-token claim, stamped by the
  customer Post-Login Action. That Action runs before the challenge it asks for, so the claim
  is true when the Action calls `api.multifactor.enable()` (Auth0 then issues tokens only after
  a successful challenge; a failed, expired or replayed code gets no token) or when the
  session's methods already include `mfa` (a refresh grant from such a session). A refresh
  grant from a session that never passed one is false. A staff MFA reset leaves the person
  unenrolled: the claim is false until they enrol again — recovery is never a bypass.
- **Enforcement is server-side, per request**: `WorkspaceGuard` refuses every non-GET by an
  owner/admin of a workspace with money at risk from a session without the claim, `403
  MFA_REQUIRED`. The state is read on every such request (`WorkspaceMfaService`: `bal:{ws}`
  else the ledger sum, `tenants.auto_topup_json`, the policy), so a session already open
  when a top-up lands is refused from that moment — there is no token to revoke.
- **Prospective checks** for the requests that *create* the risk: turning auto top-up on
  (`AutoTopupService.update`, after the card and pack checks), and a checkout that would
  charge a card already on file into a balance over the threshold or with auto top-up on
  (`BillingService.createCheckout`). A first purchase types its card in at Stripe and is not
  asked; the rule binds the next change instead.
- **Exempt** (`@AllowWithoutMfa()`): turning auto top-up *off*, `POST /wallet/checkout/confirm`
  (it only settles money Stripe already took — a Scale buyer returning from Stripe must not be
  stranded on W7), and support tickets (a locked-out owner can still ask for help). Reads stay
  open so the dashboard can explain itself.
- **Portal**: `GET /workspace` carries `mfa: {required, satisfied, reasons}`; the shell shows
  a banner, W7/D5 show "Verify now" on `MFA_REQUIRED`; both lead to A5 with `?next=`, where the
  step-up asks for a fresh challenge (`acr_values`), never a remembered device.

### 3. A first purchase over $1,000 is approved before it is charged (SEC-10)

- `purchaseNeedsReview({hasPaidBefore, amountCents, limitCents})`: the workspace has no
  `paid`/`refunded` purchase and the published pack price is strictly over
  `wallet_policy.max_first_purchase_cents_without_review` (100,000). Exactly $1,000 passes.
  The amount is the pack's from the published config, never the request's. Auto top-up cannot
  be a first purchase (it needs a card from one).
- **Pre-approval, not a hold.** `POST /wallet/checkout` answers `201 {status: 'in_review',
  checkout_url: null}` and creates a purchase `in_review` plus an open `fraud_reviews` row
  (`trigger = first_purchase_over_limit`, purchase, amount) and an audit row in one
  transaction, then pages ops (`purchase_review_requested`). **No Stripe session exists**, so
  nothing is charged, a webhook or replay has nothing to settle, and a rejection refunds
  nothing. One open review per workspace (`fraud_reviews_one_open_first_purchase_idx`); a
  retry or a second tab joins it.
- Staff (`super_admin`, `ops`, `finance` — `STAFF_ROUTE_ROLES.commercial`; support cannot)
  decide at `POST /admin/purchase-reviews/:id/approve|reject` with a reason code: conditional
  update `open → decided` (a second decision is `409`), purchase `in_review → approved |
  rejected`, `staff_audit_log` and the workspace `audit_log` row inside the transaction, then
  an outbox email to the owners and admins. Console: Billing → Reviews.
- **Approved** = the customer's next checkout of that pack at that price takes the approved
  purchase (conditional `approved → pending`) and opens the Stripe session for it. An expired
  session returns it to `approved`, not `abandoned`, so closing the tab does not cost a
  second review.
- **Backstop** in `fulfil()`: a paid first purchase over the limit with no approved review is
  not credited (left `pending`, `failure_reason = review_required`, critical ops alert
  `purchase_review_bypassed`), and an `in_review`/`approved`/`rejected` purchase is never
  credited by a session. "First" is per workspace, as every billable is (§6.1).

### 4. "Remember this device" for 30 days (A-29)

- An ordinary sign-in of an enrolled person is challenged with
  `allowRememberBrowser: true`: Auth0 offers its 30-day "remember this device" checkbox on
  the MFA screen and stores the trust as its own cookie (no secret or code of ours). A
  step-up (`acr_values`) never allows it.
- Remembered devices are forgotten (`invalidate-remember-browser`, `update:users`) by the
  person (`POST /me/devices/forget`, A5), after a password change (§5), and by a staff MFA
  reset or lock (SA3). The trust never widens anything else: the API still checks the
  token, the membership, the role and the MFA rule.

### 5. A password change ends every other session (A-31, half)

The `customer-post-change-password` Action posts `user.password_changed`; the worker sets
`users.sessions_revoked_at` to the change's time (only ever forward), revokes the provider's
sessions and refresh tokens, forgets remembered devices and audits `auth.sessions_revoked`.
**Not done:** the 15-minute reset-link TTL — Auth0 only lets the change-password email's
URL lifetime be set with a custom email provider, which the tenant does not have. It stays
Auth0's default until the provider is configured (D15 item).

### 6. Sign-up rules (A-24)

- **Password**: `min_length: 10` on the database connection; breached-password detection
  blocks at sign-up and sign-in (Auth0 compares a hash prefix; the password never reaches us).
  Universal Login shows the rules as the person types.
- **Terms**: Universal Login cannot carry a required checkbox, so A1's box is the first
  screen after sign-in (`/terms/`) for anyone who has not accepted `TERMS_VERSION` — new
  accounts, Google sign-ups, invitees, and everyone again when the version changes. It starts
  unticked. `POST /me/terms` writes `users.tos_accepted_at` + `tos_version` and an insert-only
  `terms_acceptances` row (person, version, time, IP, user agent; one per version). The API
  refuses `POST /workspaces`, invite accept and checkout with `403 TERMS_NOT_ACCEPTED`
  whatever the portal shows.

### 7. The invitee's address (A-34)

`GET /invites/:token/hint` (public, one `INVITE_INVALID` for every refusal) gives the login and
sign-up pages the invited address; they show it as "Invited as …" and hand it to Universal
Login as `login_hint`. **Deviation:** Universal Login lets that field be edited — there is no
locked identifier on the hosted page. The lock that holds is the API's: an invite accepted
from any other address is `INVITE_WRONG_EMAIL`, and a used or expired one is refused.

### 8. Login throttling and CAPTCHA (A-18)

There is no login code of ours to throttle: Auth0 Attack Protection is the limit — brute
force counted per email + IP, blocking at the 5th failure, now with `user_notification` so
the owner of the address gets an unblock link; suspicious-IP throttling 3 sign-ups / hour /
IP. A Redis counter in the API would count nothing — the attempts never reach it.

**The 15-minute expiry is ours (4 Nov).** Auth0 lifts a block only on the unblock link, a
password reset or an admin, never on a timer. The block reaches us as a `limit_wc` entry on
the log stream (§9); `signInBlockLift()` turns it into a `lift-sign-in-block` job on the
`webhooks` queue, delayed to 15 minutes after the block's own time (`unblock-<log id>`, so
a re-sent batch queues nothing twice), and `AccountEventsService.liftSignInBlock` calls
`DELETE /api/v2/user-blocks/{sub}` — or `?identifier=<address>` when the entry names no
user — and audits `auth.sign_in_unblocked`. The API takes no IP, so every IP's block on the
account lifts at once; a later block from another IP can therefore end early. A staff
block (SA3 lock, `blocked: true`) is not a brute-force block and is never lifted. Needs
`update:users` on the customer M2M application, already required by §4.

**Not met:** the CAPTCHA step — Auth0 Bot Detection is not on the tenant's plan. Open; see
"Open spec requirements".

A2's "6-digit code" stays a link (ADR 0017 §1); its resend is ours: `POST /me/verification-email`,
60-second cooldown (`SET NX`) and 5 per clock hour (fixed-window counter), both atomic in Redis,
Redis silent = refuse, `RATE_LIMITED` with `retry_after_s`.

### 9. Sign-in and purchase events in the audit log (A-22)

- **Sign-in**: the tenant's log stream posts to `POST /webhooks/auth/logs` (shared secret as a
  bearer header). Each entry of a type in `AUTH_LOG_ACTIONS` is stored once under its
  `log_id` and becomes one row in each workspace of the person: `auth.signed_in`,
  `auth.sign_in_failed`, `auth.sign_in_blocked`, `auth.mfa_challenged`, `auth.mfa_passed`,
  `auth.mfa_failed`, `auth.mfa_locked`, `auth.mfa_recovery_used`, `auth.mfa_enrolled`,
  `auth.mfa_removed`, `auth.password_changed`, `auth.password_reset_requested`,
  `auth.signed_out`. Plus `auth.session_ended` (D6 sign a device out),
  `auth.devices_forgotten` and `auth.sessions_revoked`. A failed sign-in for an address nobody
  owns writes nothing anywhere. Rows carry the IP, the connection and the time — never a
  password, token or code.
- **Not separately audited:** "device remembered". Auth0's log does not distinguish a
  challenge that ticked the box.
- **Purchases**: `purchase.checkout_started` (who, pack, amount, IP), `purchase.review_requested`,
  `purchase.review_approved|rejected` (staff), `purchase.completed` (inside the crediting
  transaction for Checkout and auto top-up, so a replayed webhook — which stops at `paid` —
  never writes a second), `purchase.abandoned`. Refund debits were already
  `purchase.refunded` (ADR 0022).

### 10. Switcher, launch countries, viewers (A-32, A-27, A-36)

- `GET /workspaces` answers each workspace's own balance (its `bal:{ws}`, else its ledger);
  the A7 list shows it as a pill and is re-read on open and on every switch.
- A3 offers `LAUNCH_COUNTRIES` (US, CA); the rest are listed disabled, "coming soon", and the
  default follows the browser only into a launch country. The API does not refuse other
  countries: §20 item 4 is still open and Gulf design partners (ADR 0027) may need one.
- A viewer's refused write (`FORBIDDEN_ROLE` on any non-GET) shows one "view-only" toast; a
  viewer opening W4 after go-live is sent to `/app` with the same toast. The API's role matrix
  is unchanged and is what refuses.

### 11. Magic link is retired for the MVP (A-07)

New Universal Login offers passwordless **codes**, not magic links (links need the classic,
Lock-based page we left in ADR 0017), and every link-based flow we would add is a second
sign-in system to secure. The replacement is what already works: email + password with the
reset link (A6), and Google. Revisit with the move to a custom domain and a decision on
passwordless email codes.

### 12. Microsoft sign-in is retired for the MVP (A-09)

It needs an Azure app registration we do not have, and Microsoft personal accounts do not
reliably assert a verified email, which is what a second identity for an existing address
would be linked on. Our rule is to refuse a second identity for an address (`UsersService`,
`SecondIdentityRefused`), so a Microsoft sign-in by a password user would be refused, not
linked — safe, but a dead end. Outlook and Microsoft 365 users sign up with email + password.
Revisit in P2 with Auth0 account linking driven by a verified-email check.

### 13. The MFA challenge's lockout is Auth0's (A-30)

§6.3 A5 "5 attempts then 15-min lock" is Auth0 Guardian's own rate limit on the challenge,
not configurable from the tenant file; the code screen is Auth0's. Recorded, not re-built.

## Alternatives considered

- **Hold the money (Stripe manual capture) instead of pre-approval** — charges the card
  before a decision, needs capture before the authorisation expires (7 days), and turns a
  rejection into a cancellation flow. Pre-approval moves no money until staff say yes, and
  the only packs over the limit are negotiated ones.
- **Enforce MFA for every request, reads included** — would lock owners out of the very
  dashboard that tells them why. Writes are where money moves.
- **Our own login form with a Redis throttle and CAPTCHA** — a second authentication system.
- **Keep 2 h tokens and record it** — the API check costs nothing and makes the spec true
  regardless of tenant drift.

## Consequences

- New error codes `TOKEN_EXPIRED` (401) and `TERMS_NOT_ACCEPTED` (403); `MFA_REQUIRED` now
  applies to customers. New routes: `GET /me`, `POST /me/terms`, `POST /me/verification-email`,
  `POST /me/devices/forget`, `GET /invites/:token/hint`, `POST /webhooks/auth/logs`,
  `GET /admin/purchase-reviews`, `POST /admin/purchase-reviews/:id/approve|reject`.
- Migration `20261103120000_auth_money_protection` (additive): `purchase_status` gains
  `in_review`, `approved`, `rejected`; `fraud_reviews` gains `purchase_id`, `amount_cents`,
  `currency`, `decided_at` and the one-open index; `users.tos_version`; `terms_acceptances`.
- **Existing users meet the Terms screen once** on their next visit (no acceptance was ever
  stored). Existing owners/admins of workspaces over 1,000 credits or with auto top-up on
  meet the MFA banner and must enrol or verify before their next change.
- **D15 configuration, not code** (`pnpm auth0:deploy customer`, then
  `pnpm --filter @portal/api verify:auth0`): the 900 s API lifetime, the refresh lifetimes,
  `min_length: 10`, the breached-password and brute-force shields, the
  `customer-post-change-password` Action and its trigger, the `portal-audit` log stream, the
  redeployed Post-Login Action. The customer M2M application needs `update:users` (resend,
  forget devices) beside its existing scopes. Log streams' availability on the tenant's plan
  and the remembered-browser `amr` on refresh grants are to be confirmed live.
- ~~Spec-owner sign-off is requested for §8, §11, §12 and §13.~~ Superseded 4 Nov: they are
  owed, below.

## Open spec requirements (4 Nov)

The spec ranks above this ADR, so these are owed, not retired. What each one waits on:

| Spec line | Waits on |
|---|---|
| §6.2 "then CAPTCHA" | Auth0 Bot Detection (Attack Protection add-on, paid) — a purchase decision |
| §6.2 / A4 Microsoft sign-in | An Azure app registration (client id + secret) for the `windowslive` connection, and linking for an address that already has an account |
| A6 "reset link (15-min TTL)" | A custom email provider on the tenant (the built-in one is for testing only and takes no template settings), then `urlLifetimeInSeconds: 900` on the change-password template |
| A2 "6-digit code" | To confirm live: Auth0's database connection takes `attributes.email.verification_method: "otp"` with `signup.verification.active: true` (the "Verification code email" template), which needs the Identifier-First profile and a custom email provider. If it does not hold with password sign-up, a code of our own conflicts with §6.2 "We do not hand-roll … email verification" |
| §6.2 / A4 magic link | Universal Login offers email codes (`email_otp` on the database connection), not links. A link of our own conflicts with §6.2's "no hand-rolled auth" — the spec owner picks |
| A5 "5 attempts then 15-min lock" | Auth0 Guardian's own limit, not configurable. Exact behaviour means checking codes ourselves, which §6.2 forbids — the spec owner picks |
