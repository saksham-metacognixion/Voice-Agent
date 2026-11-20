# 0046 — The 17 Nov QA batch: rules the screen had and the server did not (17 Nov 2026)

## Problem
Eleven bugs from QA's 17 Nov run on develop @ 13694f6. Most are the same defect: a rule the portal
applies on screen that a direct request skips, or a server rule that is not the spec's.

| Bug | Spec | What the server did |
| --- | --- | --- |
| Invoices readable by editors and viewers | §6.1: invoices Owner, Admin only | `GET /wallet/invoices` had no `@Roles` |
| Ownership transfer logs both membership rows | §17 least privilege | a leftover `Logger.debug(current, target)` |
| Workspace in any country | §6.3 A3: US and CA at launch | `countryCode` took any two letters |
| Workspace name error in English everywhere | §7 copy in the portal's language | A4 showed any server message with a space in it |
| Brief of spaces enables Generate | W2: 20 characters in fields 1 and 2 | `min(20)` counted spaces |
| Area code 999 accepted, another code bought | W6: area code checked for the country | `areaCode` checked the shape only |
| Own-line consent only on screen | W6 C: the consent is a required gate | no field in the request |
| A paid top-up does not block the next | §13.11: no top-up in the last 10 min | only a *pending* top-up blocked |
| A declined top-up retried every 6 h, forever | §13.11: retry daily 3× | 6-hour cooldown, no count |
| A 12 MB phone photo refused on W2 | ADR 0023: shrink, then check | the 10 MB check ran before the shrink |
| `.doc` refused on W2, accepted in knowledge | one file rule in both places | `mammoth` reads `.docx` only |
| Impossible numbers accepted on W6 / D4 | W6: a real number | already fixed by QA-106 / QA-107 (7f8b859) |

## Decision
1. **Invoices** take `@Roles('owner', 'admin')` and the manifest says so.
2. **The debug line is gone**; the transfer keeps its one `ownership moved from … to …` line.
3. **`LAUNCH_COUNTRIES` moves to `@portal/schemas`** with `isLaunchCountry` and `launchCountry`;
   `createWorkspaceRequest.country` is `launchCountry`. The portal's `src/lib/countries` re-exports
   them, so A3 and the API read one list. Adding a country (§20 #4) is still a one-line change.
4. **A4 shows `validation.name`** for any name error, never the server's English.
5. **`briefRealChars()`** (trimmed length) is what `briefReadyForGeneration` counts, and
   `BRIEF_MIN_REAL_CHARS = 20`. The stored text is left as typed. W2's counter turns amber on real
   characters and a padded field says `validation.minReal`.
6. **`areaCodeCountry(code)`** in `phone.ts` reads the country of a NANP area code from
   `libphonenumber-js/max` (local line types only, so `800` and `999` are null). `phonePlanRequest`
   (new, forward) and `buyNumberRequest` refuse a code of another country on `area_code` with
   `AREA_CODE_NOT_IN_COUNTRY`; a malformed code keeps its one shape issue. The portal says
   "{code} is not an area code in {country}" (`wizard.w6.errors.areaCodeUnknown`). The purchase walk
   (`purchaseAttempts`) still widens a *real* code with no stock.
7. **`carrier_consent: true`** is required on `phonePlanRequest` option `sip` and `importNumberRequest`
   (`z.literal(true)`). W6 sends its checkbox; D4 "Add number" gains the same checkbox. The import's
   audit row records it.
8. **Auto top-up** (`decideTopup`): a paid or refunded top-up younger than `TOPUP_MIN_INTERVAL_MS`
   (10 min) skips with `recent`; after a decline the wait is `TOPUP_FAILURE_COOLDOWN_MS` (24 h); after
   `TOPUP_MAX_RETRIES` (3) failed retries it skips with `retries_exhausted`. `failureStreak()` counts
   declined auto top-ups since the later of the last paid purchase and the last `auto_topup.enabled`
   audit row, so saving the switch on again (what a customer does after changing the card) starts
   over. `payment_intent_not_found` is not a decline. SA9 "Retry now" bypasses the daily wait and the
   limit, never in-flight or `recent`.
9. **A photo is checked after it is shrunk.** `pickedFileLimit()` (`src/wizard/upload-limits.ts`) lets a
   photo through at up to 50 MB as picked; the brief checks the shrunk upload against 10 MB. The menu
   slot and "Add a source" use the same rule.

10. **`.doc` in the brief.** `briefDocumentType` gains `application/msword`, so every
    `KNOWLEDGE_FILE_TYPES` entry is a brief type too (a schema test says so). `document-text.ts` reads
    it with `word-extractor` 1.0.4 (MIT, pure JavaScript: `saxes` + `yauzl`, no native build), loaded
    on first use like the other readers; a damaged file is `DOCUMENT_UNREADABLE`. The test file is a
    real Word 97 document made with LibreOffice (`test/fixtures/documents/price-list.doc`), because an
    OLE file cannot be written by hand in a test.

## Consequences
- A client that sent SIP plans or imports without `carrier_consent` now gets 422; the only clients are
  the portal and the tests, both updated.
- A workspace created in another country before this stays as it is; only creation is refused.
- A workspace stuck at `retries_exhausted` recovers by a purchase, by saving auto top-up on, or by staff.
