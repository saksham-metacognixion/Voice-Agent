# 0045 — The kept and brought lines carry their country code; Numbers refusals say why (QA-107, QA-108, 16 Nov 2026)

## Problem
**QA-107 (ORL-NUM-628).** W6 and D4 "Add number" took the line a customer keeps (Option B,
`existing_number` / `forward_from`) and the line they bring (Option C, `sip.number`) with the shape-only
`e164` rule. The old portal normaliser put a `+` in front of typed digits, so `5145550123` was stored as
Peruvian `+5145550123`. A number was then bought to forward from a stranger's line, the Forwarding tab
showed that line, and "Test forwarding" rang it (up to a minute of agent time on the customer's credits).
A SIP line was imported under the wrong number and never received a call. ADR 0044 stopped the portal
inventing the `+` but left these three fields on the shape rule, so a typed `+5145550123` still passed.

**QA-108 (ORL-NUM-629, -630, -673).** The portal turns a code into copy (`errors.<code>`) and the API
reused codes for different conditions on the Numbers routes:

| Condition | Code sent | Portal said |
| --- | --- | --- |
| Trial workspace, no pack bought (20 trial credits) | `NO_CREDITS` | "You are out of credits." |
| Plan includes N numbers, N are held | `PLAN_LIMIT` | "Your plan does not include that." |
| Release while a call on the number is live | `NUMBER_IN_USE` | "That number is already in use." |

## Decision
1. `phonePlanRequest` Option B `existing_number`, `sipCredentials.number` (W6 Option C and
   `POST /numbers/import`) and `buyNumberRequest.forward_from` are `dialableE164` (ADR 0044): a leading
   `+` or `00`, a real number by libphonenumber's `max` metadata, canonical form, no default region. A
   direct request gets `422 VALIDATION_FAILED` naming the field; nothing is stored or bought.
2. `normaliseE164` (portal) is `toDialableE164(value) ?? value.trim()`: formatting dropped for a real
   number, anything else passed through for the schema to refuse with `wizard.w6.errors.e164`
   ("Enter the number with its country code, e.g. +14505550123.").
3. Rows saved before the rule are not rewritten (the intended country cannot be known), but nothing acts
   on them: the activation `provision` step refuses a pending plan whose forwarded or SIP number is not
   dialable (`invalid_number`, permanent, before the billing checks and any platform call), and
   `POST /numbers/:id/forwarding/test` answers `409 FORWARDING_NUMBER_INVALID` before the marker or the
   call. D4's Forwarding panel disables "Test forwarding" and says so.
4. **The customer repairs the line on D4.** `PATCH /numbers/:id {forwarding_from}` (editor and up, the
   same `dialableE164`) on an Option B number only (`400 BAD_REQUEST` otherwise), refused while a test
   rings (`409 FORWARDING_TEST_IN_PROGRESS`: the marker names the old line). A change sets
   `forwarding_status = waiting_for_customer` and clears `forwarding_test_json`, since forwarding was set up
   and tested against the old line; a late outcome of that test matches on its id and writes nothing. The
   Forwarding tab's "Your existing line" field marks a line stored wrong from the start.
5. One code per condition: `402 PURCHASE_REQUIRED` (no paid purchase; the code "Call my phone" already
   uses), `409 NUMBER_LIMIT` (cap > 0 reached; `PLAN_LIMIT` stays for a plan with no numbers and the SIP
   gate), `409 NUMBER_ON_CALL` (release during a live call). Both added to the activation's permanent codes.
6. D4 "Add number" judges the first two before sending (`addNumberBlock()` in `numbers-view.ts`, from
   `GET /wallet`'s `last_pack_credits`, `GET /flags`' `caps.max_numbers` and the list), shows the reason
   with a link to Wallet and disables the submit; the same sentence is used if the API refuses with
   either code. The plan name comes from `shell.tier.<plan_tier>`.

## Consequences
- A forwarding number stored wrong before this change cannot be tested until the customer corrects the
  line under "Your existing line"; the refusal says where.
- The SIP line (Option C) is still not editable on D4: the platform binds the import to that E.164, so a
  wrong one is released and imported again, as before.
- `PURCHASE_REQUIRED` now also covers `POST /numbers/import` for a workspace that never bought a pack.
