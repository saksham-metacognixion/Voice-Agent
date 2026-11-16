# 0042 — A staff pause of a number is its own state (QA-104, ORL-NUM-644, 16 Nov 2026)

## Problem
Staff paused a number by writing `phone_numbers.status = 'paused'` and `paused_at` — the same two
columns the customer's "Answer calls on this number" switch (`PATCH /numbers/:id {paused}`) writes.
The customer could switch a staff-paused number back on from D4 Routing.

## Decision
1. `phone_numbers.staff_paused_at / _reason / _ticket_id / _by` (migration `20261116120000_qa104_number_staff_pause`,
   additive). The console's pause and resume write only these; `status` / `paused_at` stay the customer's.
   Resume never changes the customer's choice.
2. `NumbersService.update` answers `409 NUMBER_STAFF_PAUSED` for `paused: false` while `staff_paused_at` is set
   (checked on the row read inside the write's transaction). Other routing edits still work.
3. The trigger `guard_number_staff_pause` refuses the four columns from `portal_app` on INSERT and UPDATE.
4. `num:{e164}.number_paused` is `paused_at || status = paused || staff_paused_at`, so the §13.9 check declines
   (busy tone, `decline_reason = paused`) whatever the customer's switch says. A staff-paused number is also
   not a usable outbound caller ID.
5. `phoneNumberResponse` gains `staff_paused` and `staff_pause_ticket_id`. The reason code is **not** sent to
   customers (it is a staff classification, e.g. abuse). `paused` stays true for either pause.
6. D4 Routing shows the support notice, locks the switch and never sends `paused` while staff-paused. The console
   shows "Paused by support · #ticket", and `GET /admin/numbers?status=paused` includes staff pauses.
7. The migration moves numbers staff had paused under the old scheme (latest `number.paused` audit row by staff,
   status still `paused`) to the new columns and sets their customer switch back to on.

## Not changed
Agent and workspace pause already had a separate staff state (`agents.paused_by`, `tenants.paused_at`). The
customer's agent resume (`AgentPublishService.resume`) should be checked against `paused_by = 'staff'` separately.
