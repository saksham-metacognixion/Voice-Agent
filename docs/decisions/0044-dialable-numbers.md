# 0044 — Hand-off and block-list numbers carry their country code (QA-106, ORL-NUM-639, ORL-NUM-646, 16 Nov 2026)

## Problem
D4 Hand-off saved `4165550101` as `+4165550101` (Switzerland) and the D4 block list saved `5145550123` as
`+5145550123` (Peru). Two causes:

1. Both portal normalisers (`normaliseE164` in the transfer-targets editor, `parseBlocklist` in `numbers-view.ts`)
   stripped everything but digits and put a `+` in front, so the first digits became a country code.
2. The API checked the shape only (`e164`, `^\+[1-9]\d{6,14}$`), so the result was stored. A transfer then dialled
   the wrong country, and a blocked Montreal caller (`+15145550123`) never matched `+5145550123` and got through,
   billed.

libphonenumber's default `min` metadata would not have caught the second number: it checks length only and calls
`+5145550123` a valid Peruvian number. The `max` metadata (already used by the API's lint, outbound and caller-country
code) rejects both.

## Decision
1. `@portal/schemas` gets `libphonenumber-js` (same version as the API) and `src/phone.ts`:
   `toDialableE164(typed)` → E.164 or null, `isDialableE164(value)` (canonical E.164 and valid), and the zod
   schema `dialableE164` (`e164.refine(isDialableE164)`, so the OpenAPI pattern stays). The portal and the API
   use the same function: a row the form accepts is a row the request accepts.
2. **The country code must be typed**: a leading `+`, or `00` read as the international prefix. There is no default
   region. Neither the workspace country nor the number's country is applied, so a `+1` is never guessed.
3. Requests: `transferTarget.number` (D4 PATCH, W6 phone-plan PUT, buy, import) is `dialableE164`;
   `updateNumberRequest.blocklist` is `blockedCaller` (see the addendum). A direct request gets
   `422 VALIDATION_FAILED` with `fields: transfer_targets.N.number` / `blocklist.N`, and nothing is stored.
4. Responses: `storedTransferTarget` (the pre-QA-106 shape rule) for `phoneNumberResponse` / `phonePlanResponse`
   and `parseTargets`; `blocklist` stays `string[]`. A row saved wrong before this change still reads back, so the
   form can mark it. It is not dropped, which the next save would have turned into an erasure, and it is not rewritten:
   the intended country cannot be known.
5. Portal: the Hand-off rows are checked from the first Save (and from the start when a saved target is already
   invalid), live after that. A bad row is outlined (`aria-invalid`), "Fix the highlighted rows first." shows, and nothing is
   sent. Block-list chips are marked on Enter (`TagInput.isInvalid`), "Not a phone number in international format: …"
   lists them, and Save stays off. A 422 naming either list shows the row message instead of "Some fields need
   attention." Recent callers offers "Block" only for a caller ID the list can hold.
6. `normaliseE164` (also used by W6's existing line and D4's forward/SIP fields) no longer invents a `+`. A value
   typed without one is passed through and refused by the existing `e164` check.

## Not changed
- The §13.9 inbound check: `normalisePhone` on both sides already compares E.164 to E.164. A saved entry matches the
  platform's `from_number` once it is the real number.
- `brief.handoff_rules[].transfer_number` keeps `e164`: its input never added a `+`, and lint `transfer_number_invalid`
  already blocks a publish with an invalid one.
- No data migration. Rows saved wrong stay as they are until the customer corrects them on D4.

## Consequences
- `@portal/schemas` depends on zod and libphonenumber-js. The `max` metadata is in every bundle that imports the barrel.
- ~~A caller ID libphonenumber calls invalid cannot be put on a number's block list.~~ Reversed the same day, below.
  The platform blocklist (SA12) is unchanged.

## Addendum — review of 16 Nov 2026

1. **Formatting is accepted and removed** on both lists: spaces, hyphens, dots and brackets
   (`+1 (416) 555-0101` → `+14165550101`). `14165550101` (no `+`) and `4165550101` are refused, in the form and
   on a direct request. Pinned in `phone.test.ts`.
2. **The block list takes any number in international format**, real or not: `blockedCaller` is `+` and 1–15
   digits, `toBlockedCaller()` is what the form normalises with. The list is compared with the caller ID the
   carrier sent and never dialled, and a spoofed or odd caller ID is the main reason to block someone. The country
   code is still required — that was the bug. Recent callers offers "Block" for whatever the carrier sent that has
   digits (`blockedCallerFromCallerId`), saved the way the inbound check compares it: `normaliseCallerId` moved to
   `@portal/schemas`, and the API's `normalisePhone` is that function, so the form, the request and `decide()`
   cannot disagree. Hand-off keeps the strict rule: those numbers are dialled.
3. **Entries saved wrong are announced, not only marked.** `numbersNeedingFix()` (`numbers-view.ts`, pure) reads
   `GET /numbers`: a hand-off target that is not a real number, or a blocked caller that reads as a national
   number given a `+` (`nationalReading(entry, country)` — the number's country, else the workspace's;
   `+5145550123` in CA → `+15145550123`). `NumbersFixNotice` shows "Some phone numbers need fixing" on D1 and the
   D4 list to editors and up, each number linking to its Hand-off or Callers tab; it disappears when the entries
   are corrected and can be hidden per browser until something new is found. No new route, table or alert key.
   On the Callers tab the misread entries are listed with the number each was probably meant to be and one button
   that swaps them in the form; the customer still presses Save. Nothing is rewritten for them.
4. **Support's list** is `pnpm --filter @portal/api numbers:needing-fix [--csv]` (read-only, `adminDb`): workspace,
   owner email, number, list, the saved entry and the probable number.

A misread blocked caller is only detectable when its digits are a valid national number of that country and not a
real international one. A blocked caller that is simply not a real number is now legitimate and is not flagged.
