# 0049 — USD and CAD: workspace currency, the Bank of Canada rate, derived CAD prices (18 Nov 2026)

## Status
Implemented and tested locally. **Six of its rules are proposals awaiting the spec owner (Pramod)**,
listed under "Pending the spec owner" below; each is a setting or a single function, so a different
answer is a configuration change or a small edit, not a redesign. **Live release is blocked** on the
items under "Not built, and why".

## Problem
Spec §5.2 prices packs in USD and §5.5 #2 leaves "CAD vs USD billing" open. The code had the two
currency codes (`currencyCode`), a `currency` column on `purchases`, `packs` and `invoices`, and reports
that already keep currencies apart, and nothing else: every workspace was shown and charged the USD
price, there was no exchange rate anywhere, and no way to say which currency a workspace pays in.

## Decision

### 1. USD is the base; CAD is derived, in one place
Packs are published in USD (`pricing_configs.config_json`, unchanged). A CAD price is
`round(USD price × rate)`, computed by `convertCents()` in `shared/schemas/src/currency.ts` and nowhere
else. It works on integer cents and on the rate's decimal text as a `BigInt` scaled by 10^8. No `number`
holds a rate or a product of one, so the API, the portal and the console cannot round differently.
`priceInCurrency()` answers `null` when a price cannot be converted; null means "do not sell", never
"sell at the USD figure".

Credits are untouched by any of this. A pack grants `credits + bonus_credits` whatever it was paid in;
rates, rental, trial, expiry, grace and the alert thresholds are credit figures and identical in both
currencies.

### 2. The workspace has a currency (`tenants.currency`)
- Set at creation by `defaultCurrencyForCountry()`: CAD for a Canadian business, USD for any other.
- An owner or admin changes it with `PATCH /workspace {currency}` until the first purchase is paid.
  After that the answer is `409 CURRENCY_LOCKED`. `workspaceResponse` carries `currency` and
  `currency_locked`.
- The lock is enforced three times: the service (row lock, then a count of paid or refunded
  purchases), the trigger `guard_tenant_currency` (the customer's database role cannot change the
  column once a purchase is paid, whatever a service does), and fulfilment.
- **The first paid purchase decides.** If the currency was changed while a Checkout tab was open, the
  workspace ends up in the currency that purchase was actually charged in
  (`BillingService.settleWorkspaceCurrency`, audited `workspace.currency_set_by_purchase`). PATCH and
  fulfilment take the same row lock, so whichever commits first, the other sees it.
- After the lock only staff change it: `PUT /admin/customers/:id/currency`, `staffActionRequest`
  (reason code, note with "other"), `STAFF_ROUTE_ROLES.commercial` (super admin, ops, finance),
  `customer.currency_changed` in `staff_audit_log` and `workspace.currency_changed` in the workspace's
  own log, in the write's transaction. Nothing already charged is touched.
- Migration: workspaces that have paid, or have a payment or a review in progress, stay USD (that is
  what they were charged or quoted). A Canadian workspace with none of those becomes CAD, the default
  a new one gets, and its owner can change it back.

### 3. The exchange rate (`exchange_rates`, `ExchangeRatesService`)
- Source: the Bank of Canada Valet API, series `FXUSDCAD` (`BankOfCanadaClient`). Public, no key.
- `exchange_rates` keeps one row per (source, pair, business day). A refresh that meets the same day
  again adds nothing and moves `confirmed_at`, which is what "last successful refresh" reads. Rates are
  never updated or deleted; the app role has no DELETE grant and the customer role cannot read the
  table at all.
- The rate in force is the newest stored business day of the configured source. Weekends and holidays
  publish nothing, so Friday's rate is in force on Monday morning and that is not a failure.
- `fx-refresh` is an hourly schedule; `refreshIfDue()` asks the source only when the configured
  interval (24 h by default) has passed since the last success, so the interval is a setting and a
  failed refresh is retried within the hour. A worker that boots with no rate stored asks at once.
- **A failed refresh changes nothing.** Timeout, non-200, an unreadable body, no usable observation, a
  newest day older than the stored one, or a figure further than `fx_max_move_pct` from the stored rate
  (a misprint guard): the last valid rate stays in force and ops is alerted (`fx_refresh_failed`,
  `fx_rate_implausible`), once per incident. A rate older than `fx_stale_after_days` raises
  `fx_rate_stale` once a day and is still used.
- **There is no fallback rate in the code.** With no row stored a CAD price does not exist:
  `GET /pricing?currency=CAD` lists the USD prices with `currency_unavailable: true`, and CAD checkout,
  CAD top-ups and a change to CAD answer `503 CURRENCY_UNAVAILABLE`.

### 4. Settings, not constants
`platform_settings` (console row, then env var, then default) gained `fx_source`,
`fx_refresh_interval_hours`, `fx_stale_after_days`, `fx_max_move_pct`, `cad_rounding_step_cents` and
`cad_rounding_mode`. The defaults are the proposal: Bank of Canada, daily, nearest whole dollar
(step 100, `nearest`, half up). They are edited in System, Settings and shown on Pricing, Currencies.

### 5. `GET /pricing?currency=`
The route stays public, so the portal names the currency (the workspace's, through the one hook
`usePricing()`). The answer carries `currency`, `base_currency`, `fx {rate, observed_on, source}` and
`currency_unavailable`. What is charged never depends on this parameter: checkout prices from the
workspace row.

### 6. Checkout charges the displayed amount or nothing (`PRICE_CHANGED`)
- `ExchangeRatesService.quote(pack, currency)` is the one function that prices a pack for a charge;
  `GET /pricing` uses the same arithmetic.
- `POST /wallet/checkout` takes `expected_amount_cents` and `expected_currency`, what the button said.
  `assertPriceShown()` compares them with the quote before any purchase row or Stripe session exists.
  A difference (a new rate, a pricing publish, a currency changed in another tab) is
  `409 PRICE_CHANGED` with the latest figures in `fields`; the portal refetches the price, shows it and
  waits for another press. A converted price must be stated; a USD checkout from an older client that
  states nothing still works.
- The purchase row is written with `amount_cents`, `currency`, `base_amount_cents`, `base_currency`,
  `fx_rate`, `fx_rate_date` and `fx_rate_id` (`purchaseMoney()`). **Nothing re-prices it afterwards.**
  The Stripe session is created from the row's figures; fulfilment credits only when Stripe's
  `amount_total` and `currency` equal the row's (`amountMismatch`, unchanged).
- Stripe: a USD charge uses the synced Price from `stripe_price_map` as before. **A CAD charge is
  inline `price_data`**, because a Stripe Price is immutable and the CAD amount follows the daily rate.
  The SA5 price sync is unchanged and still syncs the published (USD) Prices only.
- An approved first-purchase review is matched on the published base price and the currency, and takes
  today's amount and rate when the customer comes back to pay.

### 7. Auto top-up
`evaluate()` prices the pack in the workspace currency with the same `quote()`, fixes the amount on the
pending purchase and charges that. `auto_topup_json.currency` records the currency the switch was saved
on in (the checkout that saved the card, or `PUT /wallet/auto-topup`); a top-up is skipped
(`currency_mismatch`) while it differs from the workspace's, and a staff currency change switches auto
top-up off so the customer agrees to the new currency by switching it on again. No rate stored is
`currency_unavailable`: skipped, never charged at a guess. Credits still come only from Stripe's
confirmation, and the confirmation is refused when its amount or currency is not the row's.

### 8. Limits that are USD figures
`wallet_policy.max_first_purchase_cents_without_review` and `staff_role_limits.refund_max_cents` stay
USD. For a CAD purchase they are converted with **that purchase's own rate** (`limitInCurrency()`,
rounded down to the cent so a converted cap never allows more than the USD cap), not today's. A refund
is made against the original PaymentIntent, so Stripe returns it in the currency it took it in; the
purchase row's amount, currency and rate never change.

### 9. Agreed billing structure
Spec §5 is unchanged and now pinned by `section5-rules.test.ts`: the four packs and their credits,
1 and 1.5 credits a minute metered per second, 15 credits rental, SIP free, 12-month FIFO expiry, 20
trial credits with no card, 10 credits of grace, alerts at 20 %, 5 % and 0, auto top-up opt-in, and
Alexandre, Adam, Mathieu and Jeanne as Premium voices.

## Pending the spec owner
Implemented as proposed, each behind a setting or one function:

| # | Proposal | Where it lives |
| --- | --- | --- |
| 1 | Bank of Canada daily USD/CAD rate, `FXUSDCAD` | `fx_source`; `BankOfCanadaClient` |
| 2 | Daily refresh | `fx_refresh_interval_hours` (24) |
| 3 | CAD rounded to the nearest whole dollar | `cad_rounding_step_cents` (100), `cad_rounding_mode` (`nearest`) |
| 4 | Currency and amount fixed when checkout begins | `purchaseMoney()`, `assertPriceShown()` |
| 5 | Workspace currency default (CA → CAD) and the lock at first purchase | `defaultCurrencyForCountry()`, `guard_tenant_currency` |
| 6 | USD review limit and refund cap converted at the purchase's rate | `limitInCurrency()`, `refundCapIn()` |

## Not built, and why
Nothing below was implemented; each needs an answer first.

- **GST/HST on CAD purchases.** No tax is calculated or added. Checkout charges the pack price only.
- **The extra knowledge base at 30 credits a month** in Phase 1 (Full Scope 12).
- **Live Stripe merchant entity and live account access**, and **a CAD payout bank account**. Until
  there is one, CAD charges on a USD-settling account are converted by Stripe at its own rate and fee.
  Every test here ran on the Stripe test account.

Shipped as they are, on purpose (Full Scope 12 owns them): the plan tier does not lapse after 12
months, promo codes and the Volume pack are not sold, and the `premium_voices` gate is not enforced.

## Alternatives considered
- **Stripe Prices per currency in `stripe_price_map`.** The table has a currency column, but a CAD
  Price would have to be recreated every day the rate moves, with a publish-like sync and archive each
  time. Inline `price_data` charges the same amount with none of that.
- **Stripe's own multi-currency Prices or Adaptive Pricing.** The rate and the rounding would be
  Stripe's, the displayed and charged figures could differ, and the spec owner's rule (Bank of Canada,
  whole dollars) could not be shown or audited.
- **Storing CAD prices in the pricing config.** Staff would re-publish pricing daily, or CAD would
  drift from USD.
- **`?currency=` resolved from the token on `GET /pricing`.** The route is public and cached; adding
  optional auth to it would fork the one path W7 uses before and after sign-in.
- **A compiled-in fallback rate for a first deploy.** Refused: an invented rate is a wrong price.

## Consequences
- Migration `20261118120000_usd_cad_currency` is additive (ADR 0034): a table, six columns, a trigger.
- A deploy starts with no rate. The worker fetches one on boot; until it lands, CAD workspaces see USD
  prices marked unavailable and cannot pay. `GET /admin/pricing/fx` shows the state and
  `POST /admin/pricing/fx/refresh` asks again.
- A CAD price can change from one business day to the next by a dollar or two. `PRICE_CHANGED` covers
  the gap between a page and a click; nothing covers a customer who compares Monday's price with
  Tuesday's, and the W7 note says so.
- Reports keep currencies apart already (ADR 0048). The Customer 360 "Lifetime sales" figure is still
  one sum, shown in the workspace currency; it is wrong for a workspace whose currency staff changed
  after purchases in the other one. Not fixed here.
- New routes: `PUT /admin/customers/:id/currency`, `GET /admin/pricing/fx`,
  `POST /admin/pricing/fx/refresh`. New codes: `PRICE_CHANGED` (409), `CURRENCY_LOCKED` (409),
  `CURRENCY_UNAVAILABLE` (503). New schedule: `fx-refresh`. New Redis keys: `fx:current:{source}`,
  `alert:fx:{kind}`.
- Exit checks: `shared/schemas/src/currency.test.ts`, `modules/config/{bank-of-canada.client,
  exchange-rates.service}.test.ts`, `modules/billing/{checkout-price,section5-rules,auto-topup}.test.ts`,
  `test/d23-currency.e2e.test.ts` (46 cases), and the money run against the Stripe test account,
  `MONEY_RUN=1 … test/money-run-currency.e2e.test.ts`.

## Addendum, 19 Nov 2026: the code review's ten findings

Ten defects found in review of this change before it was committed. The rules they settle:

- **The first-purchase review is one function asked twice** (`firstPurchaseOverLimit` in
  `billing.service.ts`): by checkout of the quote and by `fulfil` of the row the quote became. The
  limit is converted with the purchase's own rate and never the rate in force. A purchase outside the
  base currency with no rate of its own (a pack published in CAD) cannot be compared with a USD limit
  and is reviewed whatever its amount. Checkout used to fall back to the rate in force
  (`ExchangeRatesService.limitFor`, removed) while `fulfil` did not, so such a purchase was let
  through, paid, and then refused its credits.
- **`currency_unavailable` is about the rate only.** One pack that cannot be priced in the asked
  currency (published in another one, or converted to nothing) is left out of `GET /pricing`, as
  `quote()` refuses to sell it. It used to take every pack off sale, in USD as well.
- **A converted price of 0 is "do not sell".** `priceInCurrency` answers null when the rounding rule
  takes the conversion to nothing (a 100-dollar step rounded down under a 70-dollar price).
- **An approval of a row with no base price is still taken.** A row written by the previous image
  between a deploy's migration and its restart has `base_amount_cents` NULL; that image sold at the
  published price, so `takeApproval` matches such a row on its own amount.
- **A refund cap is converted only for a role that has one.** `assertRefund` takes the conversion as a
  function and calls it after it knows the cap is not null, so a missing rate cannot refuse a super
  admin; a role with a cap of 0 is told it cannot refund, not that a rate is missing.
- **"Refresh now" is two audit rows**, like a webhook replay: `fx.refresh_requested` before the source
  is asked, then `fx.refreshed` or `fx.refresh_failed`. It used to write the rate first and one row
  afterwards.
- **The daily refresh is due five minutes short of its interval** (`REFRESH_DUE_SLACK_MS`). The hourly
  tick never fires on the same millisecond twice, and a tick 300 ms early read as "not due" pushed the
  refresh an hour later about every other day.
- **A stored currency is read by `storedCurrency()` / `workspaceCurrency()`** in `@portal/schemas`
  (trimmed, upper-cased, null or the base currency for anything we do not sell in). Checkout, auto
  top-up, the refund cap and the workspace and console responses each had their own reading.
  `StripeGateway.isCurrency` had no caller and is gone.
- **The portal re-reads the workspace on `PRICE_CHANGED`** before it re-reads pricing: the pricing
  query is keyed on the workspace currency, and a currency changed elsewhere otherwise refused every
  later Pay with the same stale price.
- **`currency_locked` on a workspace response is one row of the workspace's own** (`findFirst` inside
  `withWorkspace`), not a count on `adminDb`.

## Addendum, 19 Nov 2026: what the local browser pass found

- **Adaptive Pricing is switched off on every Checkout Session** (`adaptive_pricing: {enabled: false}`
  in `StripeGateway.createCheckoutSession`). It is on for the Stripe account, and the hosted page
  offered a buyer in India their own currency: a US$49.00 pack was paid as ₹4,763.60 while the session
  and our purchase row said 4900 USD, so the amount check in `fulfil` could not see it. The customer
  now pays the amount and currency our screen showed; a buyer abroad is converted by their own bank.
  For the spec owner to confirm.
- **The Checkout invoice carries our ids** (`invoice_creation.invoice_data.metadata`: purchase,
  workspace, environment). The pinned Stripe API version no longer puts `payment_intent` on an invoice,
  so an invoice could not be matched to its purchase and the wallet showed none.
  `pnpm --filter @portal/api invoices:link` (dry run; `--apply` to write) links the invoices of
  purchases paid before this, from each purchase's own session.
- Both are pinned by `modules/billing/stripe-checkout-session.test.ts` (5 cases).
- **An auto top-up has no Stripe invoice.** It is an off-session PaymentIntent, so the wallet's Invoices
  list shows Checkout purchases only; the top-up is in Credit history. Unchanged, noted for QA.
