# 0041 — The §7.2 shell and D1 Home close: the unpublished-changes chip, the notifications bell as a read over the outbox, the balance pill's minutes, staff announcements, the Today and Credits figures, the agent card's buttons, the checklist's last two rows, and the pause ticket

Date: 16 Nov 2026. Status: **accepted**, with the calls under "Decisions taken" made in
session on the engineering recommendation and awaiting the spec owner's sign-off. Spec:
§5.4, §6.1, §7.2, §10 D1, §13.1, §16; admin §4 SA10, §8 `announcements`. Amends ADR 0014 §3
(the outbox carries in-app rows that mail nobody), ADR 0018 (the D1 cards), ADR 0019 §1
(the shell's header), ADR 0021 (a staff pause records its ticket) and ADR 0032 §4 (the
publish bar is on the Test tab too). Closes audit rows S-02, S-03, S-04 and H-02 to H-10
(`docs/audits/voice-agent-portal-phase-audit.md`, addendum of 16 Nov).

## Context

The 29 Oct audit left the global shell and Home short of the spec in twelve rows: the
balance pill showed credits and a tone but not the "≈ minutes" or the "Agent paused — top
up" copy (S-02); nothing in the shell said that a draft was ahead of what was on the phone
— only D3's own bar did (S-03); there was no notifications bell at all (S-04); the
paused-by-staff banner showed the reason and not the ticket the spec names (H-02);
`GET /announcements/active` existed in §16 and in the `announcements` table and nowhere
else (H-03); the credits card had no "≈ minutes" and no "days left" (H-05); the Today card
had no "messages taken" and no sentiment (H-07); the agent card listed agents with no
number and no Test / Publish / Edit (H-08); "Buy credits" was offered to every role, a
viewer included (H-09); and the checklist stopped at the wizard's six rows, so
"Forwarding tested" and "Invite team" never appeared — and the card was hidden the moment
the agent was published, before either could (H-10).

## 1. The unpublished-changes chip (§7.2, S-03)

`UnpublishedChip` in the header reads the same `listAgents` query the D1 card and the D3
list read, and `unpublishedSummary()` (`src/dashboard/home-view.ts`) decides: no agent
with `has_unpublished_changes` = no chip; one = "1 unpublished change" linking to that
agent's **Test tab**; several = the count linking to the agents list. The spec says the
click lands on "the agent's Test tab with a Publish button", and the Test tab had been
the one tab without `PublishBar` — it is on every tab now (the Overview keeps "Discard
draft"). Every `agent:` SSE frame invalidates `listAgents`, so a publish on any tab, a
W2 autosave or a D3 restore moves the chip without a reload; a reload reads the API.

## 2. The notifications bell is a read over the D7 outbox (§7.2, §13.1, S-04)

The spec lists five kinds: low balance, new messages captured, number provisioning done,
failed auto top-up, member joined. Two of them already left an outbox row — the low-balance
and failed-top-up *emails* — and the outbox is the one place every customer message goes
(ADR 0014 §3). So the bell is **a read over `notifications`**, not a second table:

- `GET /notifications` answers the caller's rows — `user_id` = the caller or NULL (a
  workspace-level record) — of the kinds the bell shows (`notificationKind`), on the
  `email` and `in_app` channels, newest first, twenty at most, each with `unread` and a
  `meta` of whitelisted facts (`feedMeta`: balance, pct, number id and E.164, days overdue,
  call id, caller number, email, role, name — never the email's `text` or `html`). The
  digest, an invitation and a purchase review are outbox rows and not news to a member;
  a `none` channel row (a decision not to send) is not either.
- The three events that mail nobody are written as **`in_app` rows** by
  `NotificationsFeedService.record()`: `message_captured:<call_id>` from `call_analyzed`
  when `messageCaptured()` (`message_taken` true or a `callback_number`) says so, real
  callers only; `number_active:<number id>` from the first `bind` that made the number
  active (W7's activation and a D4 purchase both end there); `member_joined:<invite id>`
  after an accepted invitation, outside the join's transaction. The INSERT is the claim
  (`dedupe_key` is unique, `skipDuplicates`), so a replayed webhook or a retried job
  records nothing twice; a row that fails to write is a warning, never a refused join or
  an unbilled call.
- **Unread is per membership**: `memberships.notifications_seen_at`, set by
  `POST /notifications/seen` when the bell opens; rows created after it are unread. The
  badge counts up to 9 and reads "9+" past it.
- One SSE topic, `notifications`, one `new` frame per row written, carrying the kind
  only; the shell's stream invalidates `listNotifications` on it.

## 3. The balance pill (§7.2, S-02)

"≈ minutes" is the balance over the published Standard rate (`creditsOutlook`, floor,
never negative), read from `GET /pricing`'s `rates.standard_per_min` — the same number W7
quotes, never hard-coded. At or below 0 the pill reads **"Agent paused — top up"** for an
owner or admin and "Agent paused — out of credits" for a role that cannot top up; the
tooltip carries the plan and, for owner/admin, where to top up. The pill opens the wallet
for everyone (a viewer may look, and the wallet says so).

## 4. Staff announcements (§16, admin SA10, H-03)

`GET /announcements/active` is in the `config` module beside `GET /pricing` and
`GET /flags` — the three reads of admin-owned configuration admin §5.3 names. It reads
`announcements` on `adminDb` (no `tenant_id`, nothing for RLS to scope by) and applies the
audience in code: `audienceIncludes()` reads `audience_json` as `{all?, plans?, countries?,
tenant_ids?}` — null, `{}` or `all: true` is everyone, every list present must match,
case-insensitively, and an unreadable value reaches **nobody** (a banner is staff's word
to customers; the safe failure of a bad filter is silence, not broadcast). A row is live
from `starts_at` (or its creation) to `ends_at`; only `type = banner` is answered; an
unknown severity reads as `info`. The portal shows them above the alert banner as plain
text (never HTML), refetched at most every five minutes, and a **dismissible** one is
hidden per browser (`portal:announcements:dismissed`, pruned to the ids still active)
because the table has no per-member row; one that is not dismissible stays until staff
end it. A failed fetch shows nothing. Writing rows is SA10's, in D20; the `e2e-db.mjs`
helper writes one for the browser suite and removes it.

## 5. The Today and Credits figures (D1, H-05, H-07)

- `GET /stats` gains `messages_taken` and `sentiment {positive, neutral, negative,
  unknown}`, both over the window's **real, analysed** calls (`is_test = false`, a
  non-null `analysis_json`): a test call's message is the owner's own. Messages are
  `custom_analysis_data.message_taken` true or a non-empty `callback_number` — the spec's
  definition, as one predicate (`messageCaptured()`) mirrored by the SQL. Sentiment is the
  platform's `user_sentiment` by its first three letters; anything else is `unknown`.
  The card shows "Positive callers 86 %" as the positive share of the calls **with a
  known sentiment** (`sentimentShare`), and "No rated calls yet" until there is one.
- The credits card shows "≈ N min at Standard" and "≈ N days left" — the balance over
  the **7-day average daily burn** (spec p. 33), from `GET /stats?range=7d`'s
  `credits_used` ÷ 7, floored. No usage in seven days has nothing to divide by and reads
  "No calls in the last 7 days"; a balance at or below zero reads "Out of credits". Every
  figure is prefixed "≈" and footed "Estimates from the published rate and the last 7
  days' use", so an estimate is never shown as a fact. `NaN` and `Infinity` are
  impossible by construction (`creditsOutlook` treats a non-number as 0).
- The auto top-up state is stated either way ("Auto top-up is off."), not only when on.

## 6. The agent card's buttons and the viewer (D1, §6.1, H-08, H-09)

`agentSummary` carries `number_e164` (the first active number pointed at the agent) and
`draft_has_prompt` (whether Publish can succeed), and `agentCardActions(agent, role)`
decides the three buttons: **Test** (editor and up, the D3 Test tab), **Publish** (editor
and up, only while a draft with a script is ahead of the live version or nothing is live
yet; a confirm dialog, then `POST /agents/:id/publish`, busy while it runs, `LINT_FAILED`
answered with a toast that opens the checks) and **Edit** (editor and up, the D3 Brief; a
viewer gets **View**, the overview). `canTopUp(role)` — owner/admin, the roles of
`POST /wallet/checkout` — gates "Buy credits" on the card, the "Top up" copy on the pill
and the wallet link on a low-balance alert. The API refuses each of these to a viewer
regardless (`FORBIDDEN_ROLE`); the gate only keeps a dead button off the screen.

## 7. The checklist's last two rows (D1, H-10)

`GET /workspace/checklist` gains `forwarding_tested` — **null** when no number forwards to
the agent (there is nothing to test, and the card leaves the row out), true once a
forwarding number's "Test forwarding" landed or the customer confirmed the forwarding —
and `team_invited` (a second member, or an invitation sent: sending one is the act the
row asks for). `complete` keeps its §6.4 meaning for the route guards; the card now hides
on the new **`all_done`** instead, so the two rows that come after go-live can be seen.

## 8. Paused by staff names the ticket (D1, admin §4, H-02)

`tenants.paused_ticket_id` and `agents.paused_by` (`customer` | `staff`) +
`agents.paused_ticket_id`, written where the pause is: the console's pause routes record
the ticket given when it is one of **this workspace's** (`StaffLimitsService.workspaceTicket`;
a foreign id is simply not recorded), the customer's D3 pause records `customer`, and
every resume clears them. A workspace pause is always staff's — nothing on the customer
side pauses a workspace — so the shell's banner reads "Your account is paused — see ticket
#N" with a link to Help, or the plain pause copy without a ticket; the agent card says
"Paused by Oraly support · ticket #N", "Paused by your team", or just "Paused" for a row
recorded before the column existed.

## Decisions taken

1. The bell is a read over the outbox plus `in_app` rows, not a notifications table of its
   own; unread is per membership. (The spec names the kinds and no storage.)
2. "New messages captured" counts a message for a real caller only, never a test call —
   on the Today card and in the bell alike.
3. Announcement dismissal is per browser; the table has no per-member state and SA10 is
   D20's. Non-dismissible banners cannot be hidden.
4. The chip opens one agent's Test tab (the spec) and the list for several (the spec says
   nothing); the publish bar is on the Test tab for that.
5. "Days left" divides by the 7-day average burn from `GET /stats?range=7d` and reads "No
   calls in the last 7 days" rather than "∞" when there is none.
6. "Forwarding tested" is not applicable without a forwarding number, and the checklist
   hides on `all_done`, not on the wizard's `complete`.
7. A staff pause records a ticket only when the ticket belongs to the workspace; the
   support role must give one (QA-034, unchanged), the others may.
8. Sentiment is the positive share of calls with a known sentiment; unknown is counted
   but not in the percentage.

## Alternatives considered

- **A `notification_center` table with a row per member per event.** Rejected: the outbox
  already is the exactly-once record of every message, and a second table would have two
  places disagreeing on whether a low-balance email was sent.
- **Dismissed announcements on the server.** Rejected until SA10 lands: it needs a
  per-member table the admin spec does not have, and a browser-local hide loses nothing
  that matters (the banner comes back on another device).
- **Computing "days left" on the API.** Rejected: both inputs are already on the wire and
  the division belongs with the copy that labels it an estimate.
- **Component tests with a DOM for the chip, bell and cards.** Rejected for this close:
  the portal's convention is pure view modules under `src/dashboard/` tested with vitest
  and the browser suite for rendering; adding a DOM test runner is its own decision.

## Consequences and deploy steps

- Migration `20261116090000_d1_home_shell` (additive): `tenants.paused_ticket_id`,
  `agents.paused_by`, `agents.paused_ticket_id`, `memberships.notifications_seen_at`.
  `deploy.sh` applies it (ADR 0034).
- Routes: `GET /announcements/active`, `GET /notifications`, `POST /notifications/seen`;
  `GET /stats` + `messages_taken`, `sentiment`; `GET /workspace/checklist` +
  `forwarding_tested`, `team_invited`, `all_done`; `workspaceResponse.paused_ticket_id`;
  `agentSummary` + `draft_has_prompt`, `number_e164`, `paused_by`, `paused_ticket_id`;
  SSE topic `notifications`. `docs/api/openapi.json` regenerated (242 operations).
- Exit checks: `backend/api/test/d21-home.e2e.test.ts` (8 cases); unit files
  `api/config/announcements.rules.test.ts`, `api/notifications/notifications-feed.rules.test.ts`,
  `api/calls/message-captured.test.ts`, `web/dashboard/{home-view,notifications-view,announcements-view}.test.ts`;
  `pnpm --filter @portal/web e2e:dashboard` with the new D1 rows and, with `E2E_USER_FILE`
  set, the viewer pass. The fixture is `pnpm --filter @portal/api e2e:d10-seed` (dev
  only): the owner identity, a paid live workspace, the agent through the real API and
  the sixty `d10seed_*` calls — a box without the old hand-made fixture runs it first.
- Pending: SA10 writes announcements (D20); the staff console does not yet show
  `paused_ticket_id` on SA2 (it is in the audit row).
