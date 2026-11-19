# USD and CAD (ADR 0049): verification evidence, 18 Nov 2026

Everything here was run on a developer box against the local Postgres and Redis, the **Stripe test
account** (the `sk_test_` key in `.env`) and the **live Bank of Canada Valet API**. Nothing was run on
staging: this change is not committed, pushed or deployed. The staging money run is still owed and its
steps are at the end.

## 1. Money run against the Stripe test account

`MONEY_RUN=1 pnpm --filter @portal/api exec vitest run --config vitest.e2e.config.ts test/money-run-currency.e2e.test.ts`
→ 16 passed. Raw output: `money-run-local.json` (run `92115b03`, 08:55 UTC). Nothing is stubbed in this
run. Rate in force: **1 USD = 1.4291 CAD**, Bank of Canada `FXUSDCAD` for 17 Nov 2026, fetched live.

Amounts are in minor units as Stripe reports them, read back from Stripe after each step.

| Scenario | Displayed amount | Stripe amount | Currency | Credits granted/deducted | Result |
|---|---:|---:|---|---:|---|
| Initial workspace currency | n/a | n/a | USD | n/a | Pass: `GET /workspace` USD, not locked |
| Starter purchase | $49.00 | 4900 | USD | 150 on the purchase row | Session verified, not paid (see note) |
| Growth purchase | $149.00 | 14900 | USD | 500 on the purchase row | Session verified, not paid |
| Scale purchase | $399.00 | 39900 | USD | 1,500 on the purchase row | Session verified, not paid |
| Pro purchase | $999.00 | 99900 | USD | 4,500 on the purchase row | Session verified, not paid |
| Saved card | n/a | n/a | USD | n/a | Pass: `pm_card_visa` attached to a test customer |
| Auto top-up (Starter) | $49.00 | 4900 | USD | +150 (balance 150) | Pass: PaymentIntent `succeeded`; a second confirmation credited nothing |
| Standard call, 2 min 30 s | n/a | n/a | Credits | −2.50 (147.50) | Pass |
| Premium call, 2 min 30 s | n/a | n/a | Credits | −3.75 (143.75) | Pass |
| Transfer, 4 min bridged | n/a | n/a | Credits | −1.00 (142.75) | Pass |
| Number rental, 1 month | n/a | n/a | Credits | −15.00 (127.75) | Pass |
| Refund (full, of the top-up) | $49.00 | 4900 | USD | −150 (−22.25) | Pass: Stripe refund in `usd` on the original PaymentIntent |
| Initial workspace currency | n/a | n/a | CAD | n/a | Pass: `GET /workspace` CAD, not locked |
| Starter purchase | CA$70.00 | 7000 | CAD | 150 on the purchase row | Session verified, not paid |
| Growth purchase | CA$213.00 | 21300 | CAD | 500 on the purchase row | Session verified here; **paid in the browser pass, §2** |
| Scale purchase | CA$570.00 | 57000 | CAD | 1,500 on the purchase row | Session verified, not paid |
| Pro purchase | CA$1,428.00 | 142800 | CAD | 4,500 on the purchase row | Session verified, not paid |
| Saved card | n/a | n/a | CAD | n/a | Pass: `pm_card_visa` attached to a test customer |
| Auto top-up (Starter) | CA$70.00 | 7000 | CAD | +150 (balance 150) | Pass: PaymentIntent `succeeded` in `cad`; credited once |
| Standard call, 2 min 30 s | n/a | n/a | Credits | −2.50 (147.50) | Pass |
| Premium call, 2 min 30 s | n/a | n/a | Credits | −3.75 (143.75) | Pass |
| Transfer, 4 min bridged | n/a | n/a | Credits | −1.00 (142.75) | Pass |
| Number rental, 1 month | n/a | n/a | Credits | −15.00 (127.75) | Pass |
| Refund (full, of the top-up) | CA$70.00 | 7000 | CAD | −150 (−22.25) | Pass: Stripe refund in `cad` on the original PaymentIntent |

Notes on what a row does and does not prove:

- **"Session verified, not paid"**: `POST /wallet/checkout` created a real Checkout Session and
  `stripe.checkout.sessions.retrieve` answered the displayed amount and currency; the purchase row
  holds the same amount, currency and (for CAD) rate. Typing a card into Stripe's hosted page needs a
  browser, so these eight sessions were left unpaid and expire on their own. One CAD pack was paid
  end to end in §2. **No USD pack was paid through hosted Checkout in this run.**
- **Credits-only rows** are wallet debits through `WalletService` at the published rates
  (`computeCharge` for the calls and the transfer, `recurring.number_rental_credits` for the rental).
  They are not real phone calls: no call was placed and no number rented in this run. The real
  call, transfer and rental paths are covered by `calls.e2e`, `d16-transfer-knowledge.e2e` and
  `d7-recurring.e2e`, which passed in the full run below.
- **The refund balance of −22.25** is 150 granted, 22.25 used, 150 reversed: the overdraft the ledger
  allows on a refund (ADR 0010).
- **Bonus credits**: the published packs carry none, so there was nothing to verify.
- **FIFO and 12-month expiry** were not part of the money run. `wallet.e2e` (19 cases) covers them and
  `d23-currency.e2e` checks the 12-month lot on a USD and a CAD purchase.
- Stripe's webhooks for this account go to the staging endpoint, so the top-up's PaymentIntent was
  read back from Stripe and handed to the handler the webhook calls. The signed-webhook route itself
  is exercised in `d23-currency.e2e` and `d6-billing.e2e`.

## 2. Browser pass: a real CAD payment on Stripe's hosted test Checkout

Playwright (Chromium) against the portal's static export, a second API on :4001 with the stand-in
issuer, the real Stripe test key and the real stored rate. 24 checks, all passed:
`browser-qa-results.txt`. Screenshots in this folder.

- A new Canadian workspace starts in CAD; Settings shows it, lets the owner change it and saves it.
- The wallet's "Buy credits" lists CA$70 / CA$213 / CA$570 / CA$1,428 with the conversion note;
  switching the currency reprices to $49 / $149 / $399 / $999 and back.
- Pay: Stripe's page shows **Growth pack, CA$213.00** (`stripe-checkout-cad.png`). Paid with the test
  card 4242…; Stripe returned to the wallet; the balance went **20 → 520 credits**.
  Correction, 19 Nov: the "CA$213" this run matched in the wallet was the pack price in the auto
  top-up card, not an invoice row. Invoice rows come from Stripe's `invoice.*` webhooks, which reach
  staging only; a local run without `pnpm dev:stripe` lists none. The invoice amount is unverified.
- After the purchase the currency field is disabled and says why, and the buy dialog states the
  currency instead of offering a choice.
- Arabic (`dir="rtl"`) and Canadian French render the new strings; no horizontal overflow at 390 px;
  no console errors.

Not covered in the browser: W7 itself (it uses the same `PackageSelector`, but paying there starts an
activation that buys a real number), the console's Currencies tab and currency dialog (typechecked,
linted, their API covered by `d23-currency.e2e`; not clicked through), and `PRICE_CHANGED` on screen
(the API behaviour is in `d23-currency.e2e`; the alert was not triggered in a browser).

## 3. Automated suites (18 Nov 2026)

| Suite | Command | Result |
|---|---|---|
| All unit tests | `pnpm test` | 2,225 passed in 9 packages (api 1,427, web 473, schemas 281, admin 20, ui 10, db 8, api-client 6) |
| API e2e, whole | `pnpm --filter @portal/api test:e2e` | 40 files, 850 passed; the money run (16) is skipped without `MONEY_RUN=1` |
| of which billing | `test/billing.e2e.test.ts` | 25 passed |
| of which D6 billing | `test/d6-billing.e2e.test.ts` | 12 passed |
| of which D13 billing | `test/d13-billing.e2e.test.ts` | 14 passed |
| of which D20 auth and money | `test/d20-auth-money.e2e.test.ts` | 35 passed |
| of which currencies | `test/d23-currency.e2e.test.ts` | 46 passed |
| Database e2e (RLS, append-only) | `pnpm --filter @portal/db test:e2e` | 5 files, 74 passed |
| Lint | `pnpm lint` | 9 of 9 tasks |
| API contract | `pnpm --filter @portal/api openapi:check` | current, 247 operations |

The first full API e2e run had one failing file, `auth.e2e.test.ts` (30 tests skipped at start-up):
`PlatformConfigModule` now needs `OpsAlertService` and that suite loads the module on its own. Fixed by
importing `AlertsModule` in the module; the run in the table is the one after the fix.

## 4. Still owed: the staging money run

Not done. It needs this change committed, pushed to `develop` and deployed (the migration runs in
`deploy.sh`), then, once in USD and once in CAD on staging with the Stripe test account:

1. `GET /admin/pricing/fx` (console, Pricing, Currencies) shows a rate; if not, "Refresh now".
2. Create a workspace (US, then CA). Check the currency in Settings and on W7.
3. Buy each of the four packs through hosted Checkout with 4242…; record the displayed price, the
   Stripe charge, the `purchases` row (amount, currency, `fx_rate`) and the credits.
4. Tick "top up automatically" on one purchase; drain the balance under the threshold; record the
   off-session charge and the credits (the real webhook delivers on staging).
5. Refund one purchase from the console as finance; record the Stripe refund and the balance.
6. Place a Standard and a Premium call, a transferred call, and let a number's rental fall due.
7. Check `PRICE_CHANGED` on screen: open W7, refresh the rate to a new business day, press Pay.

## 5. Local run, 19 Nov 2026 (localhost, Stripe test account, real webhooks through `stripe listen`)

| Check | Result |
| --- | --- |
| Unit tests, all packages | 2,230 passed, 0 failed |
| Database e2e | 74 passed |
| API e2e | 850 passed, 16 skipped (the money run, run separately) |
| Money run, USD and CAD (`MONEY_RUN=1`) | 16 of 16. Run with the local webhook forwarder paused: with it running, the dev API credits the top-up from the real webhook before the test does, and the test reads `already_paid` |
| Browser, customer: CA → CAD, US → USD, switch, prices, price-changed alert, payment, lock, invoices | Pass in both currencies |
| Browser, customer: auto top-up in USD | Saved card charged US$49.00 on the schedule, credited once, 170 → 320 |
| Browser, customer: auto top-up in CAD | Not done. Switching it on asks the owner for two-factor verification, which is the intended rule; covered by the money run |
| Console: Currencies, Refresh now, Change currency, Settings | Pass |
| Console: refund | US$49.00 in full (150 credits back, balance 170 → 20, purchase Refunded) and CA$30.00 of CA$70.00 (64.29 credits back, 470 → 405.71, purchase stays Paid). Stripe holds both refunds, succeeded, in `usd` and `cad`, with our purchase and refund ids |

Two defects were found and fixed in this run: Stripe's Adaptive Pricing charging a foreign currency,
and invoices not matched to their purchase (ADR 0049, addendum of 19 Nov).

### Second pass, same day

| Check | Result |
| --- | --- |
| Console Settings save | Pass. "CAD price: rounding" saved as Always up with a reason (Save stays disabled until one is chosen), then saved back to Nearest |
| `PRICE_CHANGED` from a real server-side price change | Pass. Buy credits was open at CA$70; the rounding change made Starter CA$71; Pay answered "The price has changed", charged nothing and the button became CA$71; the next press opened Stripe at CA$71.00. A new Bank of Canada day was not available to test with |
| Arabic and French: wallet, Buy credits, Settings currency | Pass. Right to left in Arabic, no untranslated text, no sideways scroll; CA$ shown as `70 CA$` (ar) and `70 $` (fr-CA). The rate in the French note reads `1.4326`, with a point |
| Real browser test call in a CAD business | The agent was built, the call connected and the agent spoke. Not billed locally: the public tunnel that delivers the voice platform's webhooks to this machine was down and no tunnel client is installed, so no `calls` row was written. To repeat on staging |
| Auto top-up in CAD from the screen | Not done. Saving it answers `MFA_REQUIRED` (correct), but "Verify with two-factor now" came back from the dev sign-in tenant without asking for a code and without the verified claim. A sign-in question, outside this change |
| Transfer and number rental in real use | Not done locally: both need a bought phone number. Staging |

## 6. Staging run, 19 Nov 2026 (commit 82aeb3c, Stripe test account, staging's own webhook endpoint)

Two test businesses under the developer's login: "QA Pay CAD 1119" (Canada) and "QA Pay USD 1119"
(United States). Card 4242 4242 4242 4242.

| Check | CAD | USD |
| --- | --- | --- |
| Deploy: migration ran, `/health/ready` 200, rate fetched (1.4326, 18 Nov) | Pass | Pass |
| Workspace currency at creation | CAD | USD |
| Prices on Buy credits | CA$70 / 213 / 572 / 1,431, with the Bank of Canada note | $49 / 149 / 399 / 999, no note |
| Starter paid on Stripe's page: amount shown = button, no other currency offered | CA$70.00 | US$49.00 |
| Credits after payment | 20 → 170 | 20 → 170 |
| Invoice listed in the wallet | CA$70, Paid | $49, Paid |
| Currency locked after the purchase | Pass | Pass |
| Auto top-up switched on at checkout, card saved | Pass | Pass |
| Console partial refund | CA$66.00, 141.43 credits back, 170 → 28.57, purchase stays Paid | US$46.00, 140.82 credits back, 170 → 29.18, purchase stays Paid |
| Auto top-up charged by the schedule once the balance was under 30 | CA$70.00, +150 once, 28.57 → 178.57 | US$49.00, +150 once, 29.18 → 179.18 |
| Growth: Stripe page amount (opened, not paid) | CA$213.00 | US$149.00 |
| Scale and Pro: Stripe page amount | Blocked, see below | Blocked, see below |
| Owner switches auto top-up off without two-factor | Pass | Pass |

Console on staging: Pricing, Currencies shows the rate, the four packs in both currencies and the
history; Refresh now stays disabled until a reason is chosen and wrote `fx.refresh_requested` and
`fx.refreshed`; System, Settings lists the exchange-rate and rounding fields at their defaults; Billing
lists each purchase and refund in its own currency.

**Blocked on staging by a sign-in defect, not by this change.** The customer Post-Login Action on
the Auth0 tenant is older than `infra/auth0/actions/customer-post-login.js`
(`pnpm --filter @portal/api verify:auth0`: "the tenant's copy differs, deploy it"). The access token
carries no `https://portal/mfa` claim, so "Verify with two-factor now" changes nothing, and an owner
is refused `MFA_REQUIRED` on every change while auto top-up is on and on any checkout that would
take a balance with a card on file over the limit. That stopped: saving the auto top-up threshold
from the wallet, and opening Scale and Pro checkouts. Fix: `pnpm auth0:deploy customer`, then repeat
those three checks.

Not run on staging: a Standard and a Premium call, a transferred call and a number rental. They need
a bought phone number on the voice platform account. `PRICE_CHANGED` on screen was checked on
localhost only (it needs a platform setting changed, which would move every staging CAD price).

### After the sign-in Action was updated (19 Nov, later the same day)

The tenant ran version 9 of `customer-post-login` (30 Sep), from before ADR 0036; the repo's file was
uploaded and deployed as version 10 through the Management API, that one Action only, because
`pnpm auth0:deploy customer` stops on a missing `read:log_streams` scope. `verify:auth0` now reports
"matches this repo". "Verify with two-factor now" asks for a code and the access token carries
`https://portal/mfa`.

| Check | CAD | USD |
| --- | --- | --- |
| Staging: auto top-up switched on from the wallet, threshold saved, then changed while on | Pass | Pass |
| Staging: Scale on Stripe's page (opened, not paid) | CA$572.00 | US$399.00 |
| Staging: Pro on Stripe's page (opened, not paid) | CA$1,431.00 | US$999.00 |
| Localhost: auto top-up saved in CAD from the wallet after the staff currency change | Pass | n/a |

Still owed on the tenant: the deploy application lacks `read:log_streams`, so the full tenant deploy
(and with it the `portal-audit` log stream of ADR 0036 §9) has not been applied from the repo.
