# ADR 0022 — The P1 admin close: tickets, refunds, staff management, the provisioning queue, and what the D13 QA changed (D13)

- Status: accepted
- Date: 2026-09-28
- Deciders: Saksham (implementation), Pramod (spec owner)

## Context

D12 (ADR 0021) built the staff console's spine: the boundary, audit, SA1/SA2/SA3/SA5/SA7/SA8/SA12/SA14
and view-as. Admin §11 lists four more things under P1 that D12 left as placeholders — SA4 "built-in
tickets + macros", SA9 "purchases / refunds / failed top-ups / basic revenue report", SA13 "staff and
settings", and SA7's "provisioning queue" and "concurrency" — and the D13 brief adds a full manual QA of
the console, the customer journey timed end to end, and a P1 exit decision.

Five questions had no answer in the spec:

1. A refund moves money at Stripe **and** credits in the ledger. Which happens first, what is the
   record if the process dies between them, and how does a double click not refund twice?
2. Auto top-up has a six-hour cooldown after a decline (ADR 0013). Staff "Retry now" must skip it —
   which of the other rules may it skip?
3. A staff member is invited by email from the console, but `staff_users.auth_provider_id` is only
   known after their first Google sign-in. How does the row meet the token?
4. Ticket macros comp credits and re-run activations: are they new code paths or the existing ones?
5. The QA asked "does staff turning a flag's default off turn it off?" — and the answer was no.

## Decision

### SA4 — tickets are rows the customer can also see; macros are the existing services

- `support_tickets` / `ticket_messages` (D2 schema, RLS) get a staff side (`modules/admin/admin-support`)
  and a customer side (`modules/support`, all inside `withWorkspace`). **The RLS policy on
  `ticket_messages.is_internal` is what hides an internal note from the customer**, not the response
  shape. Ticket ids are integers; anything else in a path is a 404.
- SLA is one constants object (`support-sla.ts`: first response 4 h, urgent 1 h; resolution 3 business
  days). A staff public reply sets `first_responded_at` and moves open → pending; a customer message
  reopens; closed refuses replies (409) but takes internal notes.
- Opening, replying, noting and PATCHing a ticket are audited without a reason code: none of them moves
  money or changes what a caller hears. **The macros do, and carry `staffActionRequest`**:
  `comp_credits` and `refund_call` are `AdminCustomersService.adjustCredits` with `ticket_id` and a
  derived idempotency key (`ticket-<id>-comp-<client key>`, `ticket-<id>-refund-<call_id>` — the same
  call on the same ticket is 409), `rerun_activation` is `ActivationService.start` for the workspace
  owner. Each appends a `system` message and audits `ticket.macro.<name>`. The admin module imports
  `activation` for that one call; the graph still ends there.
- Portal: D7 Help gets "Contact support" and "My tickets" (admin Appendix C).

### SA9 — a refund is claim → Stripe → settle, keyed by the console's idempotency key

1. **Claim**, in a transaction: a `refunds` row `pending` whose id *is* the request's
   `idempotency_key`, plus `purchase.refund_requested`. A duplicate id is 409 "already in progress".
2. **Stripe**: `StripeGateway.refundPaymentIntent` with idempotency key `refund-<row id>` (Stripe binds
   the amount to it). A thrown error marks the row `failed` and audits `purchase.refund_failed`, answers
   `503 UPSTREAM_UNAVAILABLE`, and the same key later retries the same row.
3. **Settle**, under `WalletService.withWallet`: a `refund` debit (`ref_type = refund`,
   `ref_id = <refund id>`, pre-checked under the lock so a retried settle is a no-op; the ADR 0010
   overdraft rule applies when the credits were already spent), the row `succeeded` with
   `stripe_refund_id`, `purchases.status = refunded` when Σ succeeded == `amount_cents`, the
   workspace's own `audit_log` row and `purchase.refunded`. Then `runtime-cache.refresh`.

Money leaves us before the ledger moves because the ledger can always be settled again from the
`pending` row, while a Stripe refund cannot be un-sent. A succeeded key answers the detail with no
Stripe call; a key reused on another purchase is 409. Credits reversed are
`round2(credits × amount / amount_cents)`. The role cap is `refund_max_cents`
(`StaffLimitsService.assertRefund`: null = unlimited, 0 = cannot). **A `refund` debit does not run
the auto top-up ledger listener** — it would charge the card just refunded; the 15-minute sweep still
evaluates later. Plan tier is not recomputed after a full refund (the spec is silent).

Failed top-ups: `GET /admin/topups/failed` lists abandoned auto-top-up purchases with the decline
reason, the cooldown and whether the `auto_topup_failed` alert is open. **Retry is
`AutoTopupService.evaluate(ws, 'staff', {ignoreCooldown: true})` — the only cooldown bypass, and it
bypasses nothing else** (in-flight, disabled, no card, threshold). Credits still come only from
Stripe's confirmation (ADR 0013 §D6). Disable goes through the same `writeSettings` the customer's
`PUT /wallet/auto-topup` uses, audited `topup.disabled`.

### SA13 — an invite is a placeholder row bound on first sign-in

`POST /admin/staff` (super admin + `can_manage_staff`) creates the row with
`auth_provider_id = invite|<email>`. `AuthGuard.authenticateStaff()` reads the row by `sub` on every
request; when `sub` is unknown and the token carries `https://portal/email` — the claim the staff
Post-Login Action now stamps, the only email claim trusted, as on the customer side — it runs one
`updateMany` whose `where` names the placeholder, so the first identity wins atomically and a second
identity for the same email finds no placeholder and is refused with `STAFF_ONLY`. Nobody changes
their own role or deactivates themselves; the last active super admin is never demoted; a limits
matrix that would clear `super_admin.can_manage_staff` is refused (409). The row is read per request,
so `active = false` refuses the very next call. **The staff Action must be redeployed
(`pnpm auth0:deploy staff`) before a real invite can bind on staging.**

### SA7 — the provisioning queue is the `jobs` table, concurrency is the `active:{ws}` hashes

`GET /admin/provisioning` lists `activate-agent` / `provision-number` / `knowledge-sync` rows with the
pure `activation-state` view (step, progress, attempt, customer-safe error) and `retryable`; retry is
the existing `POST /admin/jobs/:id/retry`. `GET /admin/concurrency` walks the hashes like the monitor
(expired entries ignored) against `caps:{ws}`; `live: null` and `complete: false` on a Redis outage or
a truncated scan — never zero.

### What the D13 QA changed

The QA ran the API matrix (D12 routes 157 scenarios, D13 routes 70) and the console in headless Chrome
against the local stack (real Stripe test mode, real voice platform for the journey). Product changes
it forced:

- **Flags**: the resolver is `default_on || bucket < rollout_pct`, so "default off, rollout 100 %" is
  on for everyone — turning the default off in the console changed nothing for customers. The table
  now shows an "Effective" column and a new flag starts at 0 % rollout; the semantics stay.
- **`?q=%00` answered 500**: Postgres 22021 is now `422 VALIDATION_FAILED` in the exception filter.
- **Search**: `GET /admin/calls` and `GET /admin/numbers` search the customer's and the agent's name
  (the console's placeholder promised it; the API only matched ids and digits).
- **Needs attention** gains `failed_activations_24h`, `failed_topups_24h` and `onboarding_stuck`
  (paid, older than 7 days, wizard unfinished) — the three the ops rota asks about first.
- **768 px**: the health strip's counters pushed the header past the viewport on every page; they are
  `lg:` only now.

## Alternatives considered

- **Ledger first, then Stripe** for refunds: a Stripe failure would then need a compensating grant, a
  second ledger row for a movement that never happened. Rejected.
- **A `stripe_refund_id` idempotency**: unknown until Stripe answers, so a double click before the
  answer would create two rows. The console's key (the row id) is known before anything is sent.
- **Binding staff invites by a bare `email` claim**: refused for the same reason the customer side
  refuses it (ADR 0002): only the namespaced claim the Action stamps is ours.
- **Changing the flag resolver** so rollout applies only when the default is on: it would flip every
  existing flag's meaning; a visible "Effective" column and a safer default were enough.

## Consequences

- New exit checks: `test/d13-support.e2e.test.ts` (16), `test/d13-billing.e2e.test.ts` (13),
  `test/d13-staff.e2e.test.ts` (14); the D12 suite stays green (32). Full unit run 503.
- The staff Auth0 Action stamps `https://portal/email`; the live staff tenant needs the deploy.
- Refunds against real Stripe are exercised only by the journey's real purchase (the fixtures carry
  synthetic payment intents). The e2e suites stub the gateway at `refundPaymentIntent`.
- Not built (P2, admin §11): promo codes, custom deals, SA6, SA10, SA11, act-as, approval workflow,
  revenue/COGS/deferred reports beyond the summary, ticket SLA automation, Slack routing, IP allowlist.
