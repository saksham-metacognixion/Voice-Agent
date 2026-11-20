# ADR 0018 — The customer dashboard (D1 Home, D2 Calls, D3 Agents)

- Status: accepted
- Date: 2026-09-24
- Deciders: Saksham
- Scope: `frontend/web` (`/app`, `/app/calls`, `/app/agents`, `/app/agents/detail`), `frontend/ui`
  (Checkbox, Tabs), `frontend/api-client` (`exportCalls`), `backend/api` `calls` and `agents`
  modules, D10 (§10 D1–D3, §16)

## Context

D8 and D9 built the wizard; D10 is the three screens an owner opens every day. The API
already had almost everything D1–D3 read (`GET /calls`, `GET /calls/:id`, `PATCH /calls/:id`,
the signed recording proxy, `GET /stats`, `GET /workspace/checklist`, `GET /alerts/active`,
`GET /wallet`, the whole agents surface) and the `call:{id}` SSE frames. Four things the
spec's D2 asks for were not there: sorting and a total for the pager, `POST /calls/export`
(in the §16 table, never built), a bulk "mark handled", and a way for the Advanced editor
to lint what is typed before it is saved. The portal is a static export (ADR 0008): no
dynamic segments, so `/app/agents/[id]/*` and `/app/calls/[id]` need another shape.

## Decisions

### 1. Sort, total and `sentiment` on `GET /calls`; nothing else on the list changes

`?sort=started_at|duration_s|credits_charged&order=asc|desc` (`callSort`, `sortOrder`).
Whatever the column, `created_at` and `id` follow in the same direction so the order is
total and the §16 keyset cursor resumes from one row; nulls go last in either direction
(a call still ringing has no duration). The cursor is resolved by an explicit keyset
predicate (`afterPosition()`), not Prisma's `cursor`: Prisma compares the sort columns as
a tuple, and a tuple comparison against NULL is NULL in Postgres, so once the cursor row
sat in the null tail — every missed call has no duration and no credits — the next page
came back empty while `total` said otherwise (review, 24 Sep 2026). A cursor naming a row
this workspace cannot see is `400 INVALID_CURSOR`, never a page. The page carries `total` — one indexed count per
request, on `(tenant_id, started_at)` / `(tenant_id, status)` — because a pager that says
"1–25 of 312" is the D2 spec, and the count is cheaper than a second query the client
would otherwise make. `paginated` gained an optional `total`; other lists leave it out.
`callSummary.sentiment` is `analysis_json.user_sentiment` read server-side, so the list's
mood column (spec p. 34) needs no analysis blob on the wire. `?handled=true|false` joins
the filters.

### 2. Bulk "mark handled" is `PATCH /calls {ids, handled}`, one statement

`callsBulkPatch`: up to 200 ids, one `updateMany` under `withWorkspace`. An id from another
workspace matches nothing — RLS, not a per-id check — and is neither an error nor a leak.
The answer is `{updated}`: how many of the ids are now in the asked-for state, so a row
already handled counts and a foreign id does not. Marking keeps the first `handled_at`.
Same roles as the single `PATCH /calls/:id` (owner/admin/editor).

### 3. `POST /calls/export` streams CSV in batches, capped

The body is `callFilters` plus optional `ids` (the selection) and the sort — the request
body the D2 page already holds. The reply is `text/csv` with a `Content-Disposition`
filename, produced by an async generator: 500 rows per `withWorkspace` round trip (no
long-lived connection, ADR 0006), resumed by keyset on the same total order as the list,
and capped at `CALLS_EXPORT_MAX_ROWS` (10 000). Columns are the D2 list's plus the note;
no platform id beyond the call id, no COGS. Cells are RFC 4180 quoted and any cell that a
spreadsheet would run as a formula (`=`, `+`, `-`, `@` — every E.164 number) is prefixed
with a tab. The generated client skips this route (`client: false`); `exportCalls()` in
`@portal/api-client` is the hand-written fetch that returns a Blob and the filename.

### 4. `POST /agents/:id/versions/:v/lint` is a dry run of the save

The same `lintPrompt` a save, a generation and a publish run, on the same text a save would
store (guardrails appended first), against version `v`'s brief and language. Nothing is
written and no frame is published. Unlike `promptUpdate` the prompt may be short or empty,
because `prompt_empty` is a finding the editor wants to show, not a 422. Read-only, every
role. The editor calls it 700 ms after the last keystroke.

### 5. The first `call:` frame carries what a toast needs

`registered` / `missed` (the inbound decision job) and `in_progress` (`call_started`) now
carry `from_number`, `agent_id`, `channel`, `direction` and `is_test`. D1 and D2 subscribe
to the **whole** workspace stream (a `call:{id}` topic cannot be subscribed to before the
id exists) and act on the topic prefix; the toast fires once per call id, on its first
frame, and only when `channel = phone` and not `is_test` — the customer's own browser test
call is not news. Every frame still means "re-read the resource": `useDashboardLive`
folds a burst into one invalidation of `listCalls`, `getStats`, `getCall`, `getWallet`,
`listActiveAlerts` or `getAgent` 400 ms later. The frames stay small; nothing is replayed.

### 6. Routes in a static export: `?id=&tab=` and `?call=`

`/app/agents/detail/?id=<agent>&tab=overview|brief|prompt|voice|knowledge|test|versions|settings`
is the spec's `/app/agents/[id]/*`, and `/app/calls/?call=<id>` opens the D2 detail as a
drawer over the list — the same flattening as `/invite/?token=` (ADR 0017). `agentPath()`
and `callPath()` in `src/routes.ts` are the only places that build them.

### 7. D2's filter state lives in the URL and nowhere else

`useUrlQuery()` reads `window.location.search`, writes with `history.pushState` (a filter,
a sort, a page — things to step back from) or `replaceState` (opening a drawer), and
follows `popstate`, so a refresh, the back button and a pasted link restore one view.
`calls-url.ts` is the pure encode/decode; a malformed value falls back to the default
instead of reaching the API. Date presets are computed as instants from the **workspace
timezone's** local midnight (`startOfLocalDay`), matching `GET /stats`. Pages are the API's
keyset cursor plus a 1-based `page` in the URL beside it (a cursor without one reads as
page 2), so a reloaded or pasted `?cursor=` still labels itself "26–50 of 312" and can step
back; the cursors walked to get there are remembered per filter in the tab's
`sessionStorage`, and Previous from a pasted link — no history — returns to page one
(review, 24 Sep 2026).

### 8. Reuse, not rewrite: the wizard's form bodies became shared components

`BriefFields` (W2's 13 fields) and `VoiceSettings` (W3's picker and dials) were lifted out
of their pages and are rendered by both the wizard and the D3 tabs, so the two cannot drift
on a field, a hint or a limit. The Knowledge, Test (real browser call, after-call card,
feedback) and Improve panels are used as they were. The D3 Advanced editor edits the
**editable body** only; the §9.4 block is shown read-only beneath it, and a save is
`PUT …/versions/:v/prompt` — a new immutable version that becomes the draft.

### 9. The 30-day chart is inline SVG, one series at a time

No charting dependency. One hue (`fill-primary`), 4-px rounded tops anchored to the
baseline, a 2-px gap, a recessive grid, a hover tooltip on every column, and a table view
under the chart. Days the API returned no row for are drawn as the zeros they are, over
the window's local days derived from `to` in the workspace timezone (`activitySeries`).
Calls, minutes and credits are a toggle, never a second axis.

### 10. Tables drop columns on a phone rather than forcing a wide layout

Chrome sizes the mobile layout viewport from a table's minimum width even when the table
sits in an `overflow-x: auto` wrapper, so a `min-width: 46rem` table widened every page it
was on to 451 px at 390 px. Below `sm` the D2 table keeps When, Caller and Status (the
drawer has the rest) and the Versions table keeps Version and Actions; the wide layout
returns at the breakpoint. Verified at 390 px by `scripts/e2e-dashboard.mjs`.

## Consequences

- `docs/api/openapi.json` and the generated client changed: three routes added, `GET /calls`
  gained query parameters and `total`, `callSummary` gained `sentiment`. A client built
  against the previous API fails the `callSummary` parse on `sentiment`, so the portal and
  the API deploy together, as they already did.
- `frontend/web/scripts/e2e-dashboard.mjs` is the D10 exit check: signs in through the
  local issuer as the owner of a live workspace, drives D1, D2 and D3 against the real API
  and worker, publishes a `call:` frame on the workspace's Redis channel to prove the SSE
  path, and screenshots every screen in light and dark and at 390 px.
- Tests: `backend/api/test/calls-api.e2e.test.ts` covers sort, total, keyset paging under
  a sort, `handled`, `sentiment`, the bulk route (including a foreign id and a viewer) and
  the export (columns, filters, ids, isolation); `csv.test.ts` the quoting and the formula
  defence; `frontend/web/src/dashboard/*.test.ts` the URL state, the 30-day series, the
  transcript and analysis parsers and the line diff.

## Rejected

- **Offset pagination for D2.** The spec's cursor stays; the total is what a pager needs
  from it, and inserts during reading never skip or repeat a row.
- **Client-side sort or export.** Thousands of rows are not a browser's job; both are the
  server's, on the same filter.
- **Toasting on every `call:` frame.** `in_progress` follows `registered` a second later
  and browser test calls are the customer's own; one toast per call id, phone only.
- **A charting library.** One bar series does not justify a dependency in a static export.
- **A per-tab route file for D3.** Eight files that each read `?id=`; one page and a
  `Tabs` primitive is the same URL contract with one loader.
