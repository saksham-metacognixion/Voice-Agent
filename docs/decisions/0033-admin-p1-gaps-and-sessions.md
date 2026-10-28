# 0033 — The admin P1 gaps QA filed on 28 Oct, and the portal's own-session list

Date: 28 Oct 2026. Status: accepted. Closes the seven QA tickets filed against the
console and Settings → Security on 28 Oct. **Amends ADR 0021** ("Not in D12": overrides,
number release/resync, and the console's reconciliation view are now built) and **ADR
0022** (revenue/COGS/deferred reports are no longer "not built"). Builds on ADR 0006
(RLS, `adminDb`), ADR 0010 (the ledger), ADR 0011 §7 and ADR 0014 §6 (reconciliation),
ADR 0013 (look-before-you-buy provisioning), ADR 0021 (reason codes, staff audit).

## Context

QA compared the console with the admin spec's endpoint table (p. 20) and SA2/SA7/SA8/
SA9/SA12/SA13, and the portal with §6.2. The admin §11 phasing puts "Numbers
pause/release/retry", SA7's provisioning queue and SA12 reconciliation in **P1**, so
those were gaps rather than deferrals; the reports and settings were P2 but cheap once
the data was there. `tenant_overrides` and `reconciliation_runs` already existed and were
read by the system; only the staff side was missing.

## Decision

1. **Overrides** (`PUT /admin/customers/:id/overrides`): concurrency cap, KB allowance,
   max agents, max numbers; the whole set replaced, null = the plan's. Roles super admin,
   ops, finance (`STAFF_ROUTE_ROLES.commercial`, the §2.2 "change plan tier / caps" row).
   The write rebuilds `caps:{ws}` and `num:{e164}`, so the inbound path sees it on the
   next call. Grace stays pricing-wide (`wallet_policy`): no override column for it.
2. **Number actions** (`POST /admin/numbers/:id/release|resync|reprovision`) go through
   `NumberProvisioningService`, the customer's own D4 paths: release platform first and
   refused on a live call; resync is `bind`'s read-compare-update; reprovision only from
   `failed`, through the `provision-number` job.
3. **A staff re-run frees a finished job's id** (`JobQueues.freeFinished`). A step machine
   that gives up *returns*, so BullMQ keeps it as completed for an hour and `add(…,
   verify)` (which replaces only a *failed* job) answered `exists` and ran nothing.
   `POST /admin/provisioning/:jobId/retry` is the jobs retry narrowed to the queue's
   types; an activation row from before payloads were kept is retried with the payload
   rebuilt from `steps_json` (`retryPayload`).
4. **Call refund and flag** (`POST /admin/calls/:id/refund|flag`). The refund is both legs
   as one credit adjustment keyed on the call, and is the SA4 `refund_call` macro's path,
   so a call is refunded once whichever screen asks. A flag is three columns on `calls`
   (`flagged_at|flagged_by|flag_note`); no customer response shape carries them.
5. **Reconciliation** (`GET /admin/reconciliations`, `POST …/run {date?}`) runs one ended
   UTC day through the schedule's own `CallReconciliationService.run`: upserted per
   window, alerted once per window, as the nightly job.
6. **Reports** (`GET /admin/reports/revenue|cogs|deferred|breakage`, `GET /admin/kbs`)
   aggregate in Postgres on `adminDb`. A credit is valued at what its own lot's purchase
   paid; credits nobody paid for (trial, adjustment) are counted apart at no value;
   currencies are never added together (§20 item 2 is open). COGS revenue is an estimate
   at the 12-month average price per credit, because the ledger names only the first lot
   a debit drew.
7. **Platform settings are rows with the env var as fallback** (`GET|PUT /admin/settings`,
   `PUT /admin/concurrency/allowance`): `platform_settings` holds the concurrency
   allowance, its alert % and the reconciliation drift threshold, resolved console row →
   env var → default and cached at `settings:platform` for 60 s. Only settings something
   reads are stored; a box with no rows behaves as before.
8. **Own sessions** (`GET /sessions`, `DELETE /sessions/:id`, any role, `@NoWorkspace()`):
   read from the customer tenant's Management API by the caller's `sub` only; ending one
   checks ownership (404 otherwise), deletes it and revokes its refresh tokens. A view-as
   credential is refused. Unconfigured answers `available: false`, never an empty list.

## Alternatives considered

- **Our own `user_sessions` table keyed on the token's `sid`**, refused per session by
  AuthGuard. It would work without the Management API, but needs the `sid` stamped on
  every access token (refresh grants included) and duplicates what the identity provider
  already records; the provider is the one place a session can actually be ended.
- **Reports from a ledger replay** for exact per-lot recognition. Rejected for now: the
  ledger records only the first lot a debit drew; the estimate is labelled as such.
- **Settings as one JSON row.** Rejected: per-key rows let "reset to the env var" be a
  delete, and each key is validated on its own.

## Consequences

- The customer M2M app needs `read:sessions` and `read:refresh_tokens` on each tenant
  (`docs/runbooks/auth0.md` §1). Confirm the tenant's plan exposes the Sessions endpoints
  of the Management API before relying on the card in production.
- A signed-out device keeps the access token it holds for up to the 2 h SPA lifetime; the
  copy says so.
- Two migrations: `20261028130000_calls_staff_flag`, `20261028140000_platform_settings`.
