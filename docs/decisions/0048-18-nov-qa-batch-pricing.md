# 0048 — The 18 Nov QA batch: pricing publishes and the staff console (18 Nov 2026)

## Problem
Fourteen bugs from QA's 18 Nov read of develop @ 65da87a, all in SA5 pricing, SA2, SA7 and SA9. Most
were confirmed in code and not reproduced on staging, because reproducing them needs a pricing publish
that changes prices for everyone there.

| Bug | Spec | What the code did |
| --- | --- | --- |
| Support releases a number with no ticket | admin §2.2, §1 least privilege | `POST /admin/numbers/:id/release` took the support trio and ran no limit check |
| A pack added in Pricing cannot be bought | admin §1 rule 2, §5.2 | `purchases.pack_id` references `packs`, which only the seed filled |
| A publish opens every line limit | admin §5.2 step 5, §13.9 | `invalidateAll()` deleted `caps:*`; a missing key lets a call through |
| Auto top-up buys a deactivated pack | SA5 Packs | `evaluate()` looked the pack up without `active` |
| A sold pack cannot be deactivated | admin §5.4 | "removed" meant "not active in the draft" |
| Outbound rules missing from the preview and the audit | admin §1 rule 1 | `diffConfig` did not walk `outbound` |
| "1.5× credits", "20 free credits" typed into the catalogue | admin §1 rule 2, §5.3 | fixed text in three locales |
| A scheduled version undoes a newer publish; no cancel | admin §5 Versions | current = latest `effective_at`, not newest version |
| Customers list reads the newest 500 | SA2 | `take: 500`, then filter, sort and page in memory |
| Sales by pack and by day add USD and CAD | SA9 | grouped by pack and by day, without the currency |
| A link-only pack has no link | SA5 Packs: Visibility | nothing made or read one |
| "Keep until next purchase" promises rates stay | admin §5.2 step 6 | only the two tenant caps are kept; the dialog said "rates and caps" |
| Staff overrides not on the customer's Wallet | admin §6, D5 plan line | `GET /wallet` read the tenant row, not the caps in force |
| A blocker is overridable when it says "margin" | admin §5.4 | hard and margin blockers were told apart by their text |

## Decision
1. **Release is `STAFF_ROUTE_ROLES.system`** (super admin, ops). Support's lever on a number stays the
   pause against a ticket. The console's Release button reads `can.releaseNumber()`. A ticket given
   with the release is recorded on the request's audit row when it is the workspace's.
2. **The `packs` catalogue follows the published config.** `PlatformConfigService.writePackCatalogue`
   upserts every pack of the config inside the publish and rollback transactions. `ensurePackRow`
   creates a missing row before a purchase row is written (checkout, the review it files, auto
   top-up), so an environment whose pack was published before this heals on the first purchase.
   Rows of packs a later version drops are kept: purchases name them.
3. **`caps:*` is rebuilt, never dropped.** `invalidateAll()` deletes `pricing:current`, `stack:current`
   and `flags:*`, then rewrites every `caps:{ws}` that exists from the version now in effect
   (tenants and overrides read 500 at a time). A key the walk does not reach keeps the previous
   version's caps until `runtime-cache-refresh` or its TTL. Stale for minutes is safe; absent is not.
4. **One rule for "may be charged for": `purchasablePackIn(config, id)`** (active, not `hidden`), used by
   `purchasablePack`, the auto top-up setting, `evaluate()` and the sweep's retry of an intent that was
   never made. A retired pack skips with `no_pack` (the console already says "The configured pack is no
   longer sold"); nothing is charged, the switch stays on, and D5 shows `autoTopup.packGone` and asks
   for another pack.
5. **Removing is the pack leaving the config; Active off is a deactivation.** `removedPackIds()` and
   `packChanges()` are pure. The preview answers `packs.deactivated` beside `added` / `removed` /
   `changed`. The 12-month blocker fires only on a removal and now tells staff to keep the pack and
   switch Active off.
6. **Blockers are two lists.** `blockersFor()` returns `marginBlockers` and `hardBlockers`;
   `assertPublishable` never reads a message. The preview answers `hard_blockers` (a subset of
   `blockers`) and the console disables Publish on it.
7. **`diffConfig` walks `outbound`.** The `pricing.published` audit row also carries `changed_paths`
   (first 100).
8. **The version in effect is the newest version whose date has passed** (`ORDER BY version DESC`), so a
   version scheduled for later never comes back over a newer publish. The preview answers `scheduled`
   and the console warns before publishing. `POST /admin/pricing/versions/:version/cancel` (super
   admin, `can_publish_pricing`, a reason) sets `effective_at` back to NULL while the date is still
   ahead, audited as `pricing.schedule_cancelled`; a version that took effect is undone by a rollback,
   and a rollback refuses a target whose date has not arrived. `adminPricingVersion.is_scheduled`.
9. **The SA2 list is SQL.** Filter, status, sort, count and page run in Postgres over every matching
   workspace; `customerStatusSql()` is `customerStatusOf()` as a `CASE`. The ledger and last-call
   aggregates are joined (LATERAL, per matching workspace) only when the status filter or the sort
   needs them. `facts()` decorates one page of ids. `q` matches `%` and `_` literally.
10. **Money is per currency.** `adminBillingSummaryResponse.packs[]` is per pack and currency
    (`currency`), `series[].by_currency`, `kpiDay.sales_by_currency`. The old summed fields stay for
    compatibility and no chart reads them; the console draws one currency at a time (`CurrencyTabs`,
    shown only when two have data).
11. **A link-only pack's link is `/app/wallet/?pack=<id>`.** `GET /pricing?pack=` adds that one pack
    while it is active and `link_only`; an unknown, inactive or hidden id adds nothing and is not an
    error. D5 opens "Buy credits" on it (`packLinkParam`), the console shows the link on the pack card.
    Checkout already sold a link-only pack to whoever named it.
12. **The publish dialog says what is kept**: "Keep limits until next purchase" / "Apply limits now",
    and that rates, agent and number limits and plan features change for everyone either way. The
    behaviour is the spec's (§5.2 step 6 keeps caps) and is unchanged.
13. **`GET /wallet` answers the caps in force** (`capsFor`), which is what the inbound path enforces.
14. **Rates and the trial size in copy come from `GET /pricing`** (`pricingFigures`, `usePricingFigures`,
    `usePublicPricingFigures` for the sign-up page, which has no session). A sentence goes without its
    number until the pricing has loaded. `pricing.test.ts` fails on a digit in those lines.

## Consequences
- A console built before this deploy still works against the new API: every response field is added,
  none removed. An old console keeps telling blockers apart by text until it is redeployed.
- `POST /admin/pricing/rollback/:version` to a version whose date has not arrived is now 409; the
  console offers Cancel for a scheduled version instead.
- A cancelled version keeps its Stripe Prices. Publishing the same config again resumes that row and
  reuses them; otherwise they stay active on Stripe and unused.
- Staging needs no data step. The first publish after the deploy writes the catalogue rows.
- The link opens the Wallet, so a workspace still in the wizard is sent to its step and loses the
  `?pack=`. Staff send the link to a customer who is live, or assign the pack another way.

## Alternatives considered
- **Keep "latest `effective_at` wins" and refuse a publish while one is scheduled.** Blocks an urgent
  fix behind a cancel. Newest-version-wins needs no extra step and the warning says what happens.
- **Make "Keep until next purchase" also keep rates.** That is a per-tenant rate, which `calls.rate`
  and `num:{e164}` do not model, and the spec keeps caps only. The copy was wrong, not the behaviour.
- **Drop `packs` and the foreign key.** The SA9 screens read pack names from it and refund history
  names retired packs; a migration that drops a constraint ships in two deploys (ADR 0034).
- **Decline inbound calls when `caps:{ws}` is missing.** A cache miss would then be a busy tone for a
  paying customer. The fix is to never create the miss.

## Tests
`test/qa-18nov-pricing.e2e.test.ts` (17 cases), `test/d12-admin.e2e.test.ts` (release by role, rollback
targets), `admin.helpers.test.ts` (`packChanges`, outbound diff), `config.resolve.test.ts`
(`purchasablePackIn`), portal `pricing.test.ts`, `wallet-view.test.ts`, console `money-series.test.ts`.
