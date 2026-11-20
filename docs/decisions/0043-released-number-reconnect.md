# 0043 — A released number can be connected again (QA-105, ORL-NUM-631/632, 16 Nov 2026)

## Problem
`phone_numbers.e164` was unique across every row, and a release keeps the row as `released` with its
e164 (calls and rental ledger rows reference it, CLAUDE.md "Append-only tables"). So:

1. A customer who released their own SIP line could never import it again: the insert met
   `phone_numbers_e164_key` and the API answered a bare `409 CONFLICT` ("That already exists."; the
   portal said "That is already in progress."). D4's Danger Zone promises "You can import the same SIP
   number again later."
2. The import's clash check ran under RLS, so it could not see another workspace's row. A number held by
   another workspace reached the same unique violation instead of a clear refusal. Through W6 the insert
   happened in the activation worker, where `classifyError` made it a retryable `internal`: three attempts,
   then "Something went wrong while setting up your number".
3. Latent: a bought number the carrier resold after a release would fail at provisioning the same way.

## Decision
1. **Uniqueness covers the rows that hold a number** — every status except `released` — as the partial
   index `phone_numbers_e164_held_key` (migration `20261116150000_qa105_number_e164_held_unique`), the
   pattern of `jobs_one_active_per_target_idx` and `alerts_open_key_idx`. Two live rows still cannot share a
   number; nothing un-releases a row, so none can re-enter the index. A plain `phone_numbers_e164_idx` serves
   lookups that must also see released rows.
2. **A reconnect is a new row.** The released row stays as history (its calls, audit trail and rental rows
   keep pointing at it); the new row gets its own plan with freshly sealed credentials, its own inbound token,
   and the ordinary `provision-number` job. Reusing the released row was rejected: its calls would move to
   the new connection, a reconnect from another workspace would have to move the row between tenants, and
   release is final everywhere else (`provision` and `bind` refuse a released row). The audit row
   `number.import_requested` carries `reconnects_number_id` when the workspace held the number before.
3. **One holder check outside RLS**: `numberHolder()` / `assertNumberFree()` (`modules/numbers/number-holds.ts`)
   read `adminDb` for a holding row in any workspace and answer only yes/no. `POST /numbers/import`, W6's
   `PUT /agents/:id/phone-plan` (option `sip`; the plan's own row is not in the way) and the activation's
   `createNumberRow` refuse with `NUMBER_IN_USE`, "That number is already in use." (field `sip.number`) —
   the activation as the permanent `ProvisioningError` kind `number_in_use`, first attempt. A request that
   loses the race to the index gets the same answer (`isNumberHeldViolation` in `@portal/db`). Nothing about
   the holder reaches the response.
4. **A failed row still holds its number** — the platform may have the import, and staff reprovision only
   from `failed`. The customer releases it from D4 and connects again.
5. **The runtime cache cannot be undone by history.** `RuntimeCacheService.refresh` removes `num:{e164}` for
   a released/releasing/failed row only when no row of the same workspace serves that number, and then only
   while the record is still that row's (`RedisCache.delJsonIf(key, 'number_id', id)`, compare-and-delete in
   Lua). Without it, the old owner's five-minute refresh would delete the new holder's record and send its
   callers down the §13.9 fail-open path. `refreshNumber(e164)` and `CallsService.numberOf` prefer the holding
   row; `numberOf` falls back to the latest released row (scoped to the workspace when it is known) for a late
   event, which is what the single row used to answer.

## Consequences
- D4 lists both rows of a reconnected number: the live one and the released one, sorted last.
- Rollback-safe (ADR 0034): code before this change writes rows the partial index accepts.
- Tests: `test/d6-numbers.e2e.test.ts` "QA-105" (reconnect twice, cross-workspace refusal and takeover after
  release, W6 → activation, a double press, 422s and a failed import, the index itself), and
  `redis-cache.test.ts` for `delJsonIf`.
