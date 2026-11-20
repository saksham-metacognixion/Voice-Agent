# 0019 — The rest of the dashboard: D4 Numbers, D5 Wallet, D6 Settings, D7 Help, and the phone layout

Date: 25 Sep 2026 (D11). Status: accepted. Builds on ADR 0017 (portal foundation) and ADR
0018 (D1–D3). Spec: §7.2, §12.5, D4–D7 (pp. 36–39), §6.1, §6.2, §16.

## Context

D10 shipped D1–D3 over the D8 shell. Numbers, Wallet, Settings and Help were stubs, the
balance pill read `GET /wallet` on a 15 s stale time and only moved on the pages that
happened to open the workspace's SSE stream, and the dashboard's tables were "hide the
secondary columns below `sm`" — usable, but not the cards §12.5 asks for. Every screen had
to work at 390 px with a real phone navigation.

## Decisions

### 1. One SSE stream, opened by the shell (§16 `GET /events`)

`DashboardLiveProvider` sits in `PortalShell` and owns the workspace's one stream for as
long as any `/app` page is on screen. `useDashboardLive()` keeps its D10 signature — it
returns the stream state and registers a page's `onNewCall` — but no longer opens anything.
D1, D2 and D3 did not change.

The `wallet` topic's `ledger` frame carries `balance_after`, so the provider writes the
balance straight into every `getWallet` cache entry (`setQueriesData`) and then invalidates
the wallet, stats, ledger, lots and invoices. The pill and D5 move on the frame; the refetch
fills in what the frame does not say (expiry, plan, auto top-up). Frames can arrive out of
order across a reconnect, so a frame older than the last applied one (`ts`) is not applied.
`walletFrame()` (`src/dashboard/wallet-frame.ts`) is the gate: a frame without a finite
numeric `balance_after` changes nothing and throws nothing — it only triggers the re-read.

An `activation:` frame now also invalidates `listNumbers`, so a number bought from the
wizard appears on D4 without a reload.

### 2. The stream closes on `pagehide` and reopens on a persisted `pageshow`

Found while verifying at 390 px: the seventh consecutive full page load of the dashboard
hung on its first request, with the API answering in 26 ms. Chrome keeps a navigated-away
document in its back/forward cache **with its in-flight fetches**, the SSE fetch never
ends on its own, six cached documents held six sockets — the HTTP/1.1 per-host limit —
and the seventh document's `GET /workspaces` queued for ever. With the cache disabled
every load rendered; with it enabled `lsof` showed exactly six established sockets at the
moment it stuck.

`subscribeEvents` aborts its controller on `window` `pagehide` and removes the listener on
unsubscribe; `useWorkspaceEvents` bumps a generation on `pageshow` with `persisted`, which
re-runs the subscribe effect, so a restored page is live again. `openWhenHidden: true`
stays: a background tab keeps its stream, a cached document does not. In production the
API is behind Caddy over HTTP/2, where the limit does not bite — the fix is still right,
because a cached document holding a server-side subscriber is a leak either way.
`frontend/api-client/src/sse.test.ts` pins the abort.

### 3. Phone navigation is a bottom tab bar; "More" is a bottom sheet

Below `lg` the left nav becomes a fixed bar of four tabs — Home, Calls, Agents, Numbers
(`TAB_BAR_KEYS`) — plus **More**, which opens a bottom sheet with Wallet, Settings and
Help and shows as active while one of them is open. Targets are 4 rem tall; the bar pads
for `env(safe-area-inset-bottom)`, which needs `viewportFit: 'cover'` in the root layout's
viewport; `<main>` carries matching bottom padding so no page ends under the bar. The
hamburger sheet is gone. On desktop the pill moved to the foot of the sidebar (§7.2
Figure 3); on a phone a compact pill (the number alone) sits in the header.

Two header fixes fell out of the 390 px pass: the workspace switcher's button inherited
`shrink-0` from `Button` and pushed the header 9 px past the viewport on every page, and
its name was clamped to 10 rem regardless of the space left. It now shrinks with the row.

### 4. Tables become cards below 640 px — both layouts are rendered

`DataTable` (`src/components/dashboard/data-table.tsx`) renders the D10 table for `sm` and
up and a `<ul>` of cards below it; CSS picks one. Both are in the DOM on purpose: nothing
measures the viewport, the first paint is right, and there is no layout jump on
hydration. A column declares its card slot — `title`, `subtitle`, `badge`, `field`
(default) or `actions` — so a card shows every column the table does; nothing important is
hidden on a phone, only laid out differently. Numbers, recent callers, the ledger,
invoices, members, invites and the audit log use it. D2's calls table and D3's versions
table keep their bespoke rows (selection, sort headers, compare) and gained their own
card lists the same way. The D10 `hidden sm:table-cell` rule still applies to the desktop
table for tertiary columns.

### 5. `GET /audit-log` (§16, D6)

The spec lists the route and the `audit_log` table has been written by ten services since
D1, but nothing read it. `GET /audit-log?area=&cursor=&limit=` (owner/admin, the §16
keyset page) answers `auditEntryResponse`: action, target, actor (`user_id`, email, name),
IP, `meta` and time, newest first. `area` is the part of `action` before the dot
(`agent`, `number`, `member`…), a regex-validated string so a new writer needs no schema
change. It reads under `withWorkspace` like every customer read; the actor joins through
the `users_read_co_members` policy, so someone who has left the workspace reads as no
actor rather than leaking a profile. The writers' `meta` was checked: ids, field names
and booleans such as `has_password` — never a secret. The portal names the actions it
knows (`audit-view.ts`) and humanises the rest, so a new action is readable before it has
copy.

### 6. `phoneNumberResponse` gains `sip` and `calls_7d`

D4's SIP section needs the trunk's host and username and the list needs "calls 7d" (spec
p. 36). The SIP credentials live on the plan (`phone_plans.sip_json`, envelope-encrypted);
the numbers service now includes the plan and `toNumberResponse` runs it through
`SipCredentialsCipher.redact` — host, username and `has_password`, never the password.
`calls_7d` is one `groupBy` over the page's numbers on `calls.created_at`, declined calls
included. `d6-numbers.e2e.test.ts` asserts the redaction on every route and the count.

### 7. D4 detail is `/app/numbers/?id=&tab=`, and same-route navigation is observed

Like D3, the spec's `/app/numbers/[id]` flattens to a query for the export. List and
detail are one page, and the page reads its query through `useUrlQuery`, which a Next
`<Link>` to the same path does not notify — so the bottom tab bar's **Numbers** while a
number was open did nothing. `useUrlQuery` now wraps `history.pushState`/`replaceState`
once and dispatches a `portal:locationchange` event **on a microtask**: Next calls those
methods from an insertion effect, where React refuses a state update, and an inline
dispatch crashed the page. `NumbersNavContext` lets the list, the detail and the release
dialog move between the two through the page's own setter. The number's sections —
Routing, Hand-off, Callers, Forwarding (forward targets only), SIP (SIP only), Danger
zone — are tabs on that query.

### 8. What D4–D7 deliberately do not offer, and why

- **Payment methods**: cards, billing address and tax ID are the Stripe Customer Portal
  (`POST /wallet/portal-session`, spec p. 38), never Stripe Elements in the portal. The
  card on file shown is `auto_topup.card_last4`, the one auto top-up would charge.
- **Export all data / delete workspace** (spec p. 39): there is no customer route, on
  purpose — deletion is a staff-run anonymisation job because the append-only ledger
  cannot be cascaded (§17, ADR 0006) — so the page explains and links `mailto:` support
  with the workspace in the subject instead of offering a button that cannot work.
- **Status page and support chat**: no vendor is chosen (§20 item 10). Help shows the
  API's own `GET /health/ready` (calls: Postgres + Redis; background: the worker) and
  links an external page only when the build sets `NEXT_PUBLIC_STATUS_PAGE_URL` (an
  `https:` URL, else dropped). Support is `NEXT_PUBLIC_SUPPORT_EMAIL`, default the
  address the portal already showed. "Report a call" is a `mailto:` carrying the call id
  and time.
- **SMS and the weekly summary** are stored columns with no sender; Notifications offers
  what the backend sends — message emails (instant / daily digest) and low-balance
  emails.
- **Editing a SIP trunk**: `PATCH /numbers/:id` excludes provider identity by design, so
  the section is read-only (username masked, password as a flag) and says to release and
  import again. "Re-verify" and "Test forwarding" are Phase 2.
- **Sessions list / revoke**: the identity provider holds sessions; Security offers
  two-step verification (A5), a password reset email (A6) and sign-out.
- The balance pill's tone now follows §7.2 — amber under 20 % of the last pack, red at
  or below 0 — with the pre-purchase fallback of 20 credits the pill used before.

### 9. Verification

`pnpm --filter @portal/web e2e:dashboard-d11` (124 checks): the live balance over a
published `wallet` frame on D5 and on D4, malformed frames, one `/events` stream across
client-side navigation; D4 list, add dialog, rename, callers block list (E.164
normalisation, refusal, put back), forwarding, hand-off, the typed release confirmation
(cancelled — it is a real number); D5 balance/usage/ledger/invoices/auto top-up refusal
without a card/pack cards; D6 all six sections, invite → link → revoke, notification
preference round trip, audit log showing the run's own actions with the actor; D7 guides,
status, support; then every screen, tab and dialog at 390 px — no horizontal scroll,
every control inside the viewport, the tab bar present and touch-sized and covering no
content, dialogs fitting the screen, the More sheet, and D2 as cards. The D10 suite
(`e2e:dashboard`) is the D1–D3 regression check.

### 10. QA pass (25 Sep): validation errors were 500s in the compiled API

An independent QA pass (roles, empty/error states, validation, deep links, checkout
returns, reconnect, dark mode — 98 checks) found that every zod failure raised from a
`@portal/schemas` schema answered **500 INTERNAL** on `node dist/main.js` — how staging and
prod run — while every vitest suite saw 422. `@portal/schemas` is an ES module and loads
zod's ESM build; the CommonJS API `require`s `index.cjs`; the two `ZodError` classes differ,
so `AllExceptionsFilter`'s `instanceof ZodError` never matched. Present since D1, on every
route. `isZodError()` now also recognises the shape (`name === 'ZodError'` and an `issues`
array); `errors.test.ts` pins a foreign-class ZodError to 422. Verified against the
compiled server: eight routes that were 500 answer 422 with field errors.

The same pass fixed two small portal bugs — removing two allowed countries in one tick
removed only one (stale closure; functional updates now), and the invite form showed the
browser's own email message instead of ours (`noValidate`) — and left two as notes: a
routing schedule that never answers (or "business hours" with none set) can still be
saved, behind a warning; and the D5 usage chart keeps its 600×180 aspect ratio, so a
wide card has empty margins.

## Consequences

- One connection per dashboard; a component that needs live data invalidates through the
  provider and never subscribes itself.
- A new list is `DataTable` with card slots, not a `<table>`; a new destructive action is
  `ConfirmDialog` with consequences and, where the spec asks, a typed confirmation.
- A new audit action is visible to owners at once; naming it is a message-file addition.
- The two `NEXT_PUBLIC_*` names above are optional build-time values.
