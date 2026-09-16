# ADR 0010 — Wallet ledger semantics, pricing config shape, and Stripe webhook retries

- Status: accepted
- Date: 2026-09-15
- Deciders: Saksham
- Scope: `backend/api/src/modules/{wallet,billing,config,redis,webhooks}`, `shared/schemas/src/{pricing,wallet}.ts`,
  `backend/db/prisma/seed-data/pricing-v1.ts`. Implements spec §5, §13.7, §13.10, §14 and admin §5 (D3).

## Context

The spec fixes the money *rules* — append-only ledger, FIFO by `expires_at`, `bal:{ws}` rebuilt on
mismatch, `call_ended` as the only billing event, idempotency on `call_id`, a 10-credit grace
overdraft, a versioned `pricing_configs` JSON read through `GET /pricing` and `GET /flags` — but
leaves four things to the implementation. Each was decided on D3 and is recorded here so D4+ does not
re-decide them.

## Decisions

### 1. One ledger row per movement; lots are drawn down beside it

A debit that spans several lots is **one** `credit_ledger` row (`delta`, `balance_after`), and the lots
it touched are decremented in `credit_lots.credits_remaining`. `lot_id` on the row names the first lot
drawn. Not one row per lot, because the idempotency guard is a partial unique index on
`credit_ledger (ref_id) WHERE reason = 'call'` and a two-lot call would collide with itself. The
lot-level history is recoverable from the lots' remaining balances and the ledger order; if per-lot
attribution is ever needed for revenue recognition (admin Appendix A "weighted $/credit of the lots
consumed"), it is a `ledger_lot_draws` side table, not a change to the ledger.

### 2. Overdraft is a negative balance with full lots at zero; the next grant settles it out of its lot

When a debit exceeds every open lot, the lots go to 0, the ledger row records the full delta, and
`Σ delta` goes negative (down to −grace, enforced by the inbound check, not by the wallet). §5.4 says
"next top-up settles it first": the next grant writes the full `+credits` to the ledger but creates its
lot with `credits_remaining = credits + balance_before` (clamped at 0). Balance and lots agree again
without a synthetic "settlement" row.

### 3. Per-workspace advisory lock around every wallet write

`pg_advisory_xact_lock(hashtext('wallet:' || tenant_id))` at the top of the transaction. Two
concurrent `call_ended` for one workspace serialise; two workspaces never wait on each other. The
`call_id` pre-check inside the lock makes a replay a cheap no-op; the unique index remains the
guarantee if anything bypasses the lock. A purchase fulfilment (`purchases.status → paid` **and** the
grant) runs inside one such transaction, so a crash cannot leave a paid purchase without credits or
credits without a paid purchase.

A lapsed lot is swept — written off as an `expiry` row — at the top of every grant and debit, not
only by the §13.11 job. FIFO can only draw from lots that are still live, so a debit taken between a
lot's `expires_at` and the next sweep would otherwise overdraw *past* those credits and the job would
then write the same credits off a second time: a 100-credit lapsed lot plus a 10-credit call ended at
−10 rather than 0. Sweeping first makes the lazy path and the scheduled path the same path, and the
job stays as the thing that bounds how long an idle workspace carries a stale lot.

`bal:{ws}` is published **inside** that transaction, on the way out of a callback that returned, while
the advisory lock is still held. It is the one piece of I/O allowed inside a wallet transaction (Redis
is compose-local, `RedisCache` is bounded and never throws), and it buys the only ordering guarantee
available: the next writer cannot start until this one commits, so the cached balance can never land
backwards. Published after the commit instead, two concurrent debits could publish out of order and
leave a stale-*high* balance — the §13.9 inbound check would then admit calls against credits the
workspace does not have. The key also carries a 1-hour TTL (`BALANCE_TTL_S`), because it is a cache and
never the truth: anything that leaves a wrong value behind has to age out rather than sit there
forever, and `WalletService.balance()` rebuilds from the ledger on the miss.

The same ordering rule binds the *readers* that touch the key (added 16 Sep 2026 after the D3
review). `rebuildBalance()` takes the wallet lock for the few milliseconds it needs: an
unlocked rebuild that summed before a concurrent debit committed and wrote after it would put
the pre-debit balance back, stale-high. `summary()` (`GET /wallet`) runs outside the lock on
the customer connection, so it may only *fill a miss* (`SET … NX`, `RedisCache.setIfAbsent`)
and never overwrite what a writer published. Nothing else writes `bal:{ws}`.

### 4. `pricing_configs.config_json` shape

`shared/schemas/src/pricing.ts` (`pricingConfig`): `currency_default`, `packs[]` (admin §5 Packs
table, caps and feature gates ride on the pack), `rates`, `recurring`, `wallet_policy`, `trial`
(caps for `plan_tier = trial`). Version 1 is published by `pnpm db:seed` from
`backend/db/prisma/seed-data/pricing-v1.ts` **only when the table is empty**; every later version is an
SA5 publish. `GET /pricing` returns the customer-visible projection (`publicPack`, no hidden packs, no
staff-only policy fields), filtered by `?region=`.

Caps for a workspace (`caps:{ws}`, `GET /flags`) compose as admin §5.3 says: `tenants.concurrency_cap`
and `kb_allowance` (copied from the pack at purchase — this copy is the default grandfathering),
`max_agents`/`max_numbers`/gates from the current config's pack for the tenant's tier, then
`tenant_overrides` field by field. Kill switches are the four SA12 keys and respect `expires_at`.

Not every tier has a pack: Volume is negotiated per customer, so it is a `custom_deals` row and
deliberately absent from `config.packs`, and a pack retired in a later version leaves the same hole for
tenants still on that tier. `tierCapsFor()` therefore walks *down* the §5.2 ladder to the nearest tier
that does have a pack (volume → pro) and falls back to `config.trial` only for the trial tier itself.
Falling back to trial for everything without a pack handed a Volume customer `max_agents: 1`,
`max_numbers: 0` and every gate off.

### 4a. Plan tier ranks by the §5.2 ladder, not by `purchases.credits`

`purchases.credits` includes promotional `bonus_credits`, so ranking the last 12 months of
purchases by that column could let a Growth pack sold with a bonus outrank Scale. Fulfilment
resolves each paid purchase to its pack (current config, else the `packs` catalogue row a
retired pack left behind) and takes the highest tier; ties go to the larger credit count.

### 5. Stripe webhook failures answer 5xx until the queue lands (D4)

`POST /webhooks/stripe`: verify → `webhook_events` upsert → process **inline** → 200. If processing
throws, the failure is recorded on the row and the answer is **500 on purpose**: Stripe retries for
three days, `WebhookEventsService.store()` sees an unprocessed row and returns `retry` instead of
`duplicate`, and every handler is idempotent. Returning 200 would turn one transient error into a
paid purchase that never credits. A duplicate of a *processed* event is 204. This is the opposite of
the Retell rule (never 5xx after store — ADR 0003) because a Retell retry storm answers a live call
and a Stripe one does not; D4 moves both behind BullMQ and this exception disappears.

Fulfilment credits nothing unless `session.amount_total` and `session.currency` match the pending
purchase's `amount_cents` and `currency`. The two can drift without anyone touching this code — a
`stripe_price_map` row left behind by an older config version, or a Price edited in the Stripe
dashboard — and the session is the record of the money while the purchase is the record of the goods.
A mismatch is logged at error, leaves the purchase `pending` with the session and payment-intent ids
on the row for SA9, and answers 200: a human has to settle it, and three days of Stripe retries will
not help.

### 6. Redis is a cache that can be missing

`RedisCache` never throws and never waits past its budget (500 ms default; the inbound path passes
150 ms). A failed read is a miss, a failed write a no-op. Config keys carry a 60 s TTL so admin §5.2's
"portal re-reads within 60 s" holds even if an invalidation is missed. BullMQ and pub/sub (D4) use
the raw client with their own semantics.

### 7. Checkout never leaves a `pending` purchase without a session

The pending purchase is written before the Stripe call (its id is the `client_reference_id`).
If Stripe refuses the session, that row is flipped to `abandoned` before the error propagates:
with no session there will never be a `checkout.session.expired` to do it, and SA9 would list
a ghost forever. A `promo_code` on the request is refused with `400 PROMO_INVALID` until promo
pricing (admin SA6) is wired into the session — accepting it would charge full price and record
a promo that was never applied.

## Consequences

- Nothing outside `WalletService`/`WalletTx` writes `credit_ledger` or `credit_lots`. Billing,
  metering (D4), rentals and staff adjustments all go through `withWallet()`.
- `computeCharge()` (`modules/calls/metering.ts`) is pure and tested against the D2 fixtures; the
  rate is a parameter captured at `call_started`, never read from config at `call_ended`.
- Two copies of the §5.2 numbers exist by design: the seed (bootstrap) and
  `backend/api/test/fixtures/pricing/config-v1.json` (test data). Code reads neither.
- Two `wallet_policy` fields are stored but read by nobody yet: `max_first_purchase_cents_without_review`
  (the admin §5 fraud gate at fulfilment — belongs to SA13 fraud reviews) and
  `mfa_required_above_balance` (a D5 owner-action gate). A first purchase of any size credits
  without review until SA13 lands. Do not assume either is live.
- `WalletService.debit()` does not enforce the −grace floor; only the §13.9 inbound check does,
  because a call already in progress is never cut for money. The §5.3 recurring job must check
  the balance first and take the "release after N days at zero" path rather than debit into an
  unbounded negative.
