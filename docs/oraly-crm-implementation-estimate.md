# Oraly CRM: implementation assessment and estimate

| | |
| --- | --- |
| **Subject** | `docs/oraly-crm-spec.md` v0.2 (28 Oct 2026, owner Pramod): Funnels & Lead Management |
| **Assessed against** | `develop` at `0d6ca95` (28 Oct 2026, after D18 outbound click-to-call) |
| **Prepared** | Wed 28 Oct 2026, 14:30 IST |
| **Target** | **Production deploy on Thu 5 Nov 2026** (code freeze Wed 4 Nov evening) |
| **Status** | Analysis only. No code, schema or data was changed to produce this |

---

## 1. Executive summary

**The whole CRM spec cannot be deployed on Thursday 5 November. A useful first release can,
with almost no slack.**

- **Size.** The spec adds 17 tables, about 71 API routes, 10 screens (C1–C10), 10 scheduled
  jobs, 5 SSE topics, an outbound dialer, a post-call LLM pipeline, and changes to the admin
  console. The spec's own phasing (§16) puts this at **+1 week P0 spike and 6–8 weeks for
  P1**.
- **Our estimate for the full MVP (spec P1 plus automated intake):** **78 h best,
  134 h realistic, 227 h worst.** These are focused, AI-assisted developer hours in the
  same unit as `docs/plan/tasks.csv` (see §5.1 for how this unit was calibrated). For one
  developer that means the full MVP lands around **Mon 9 Nov best, Tue 17 Nov realistic,
  Mon 30 Nov worst.**
- **Capacity before the deploy** is about **54.5 build hours**: the rest of today plus Thu
  29 Oct – Wed 4 Nov. Thu 5 Nov is the release day itself. That is about **40 % of the
  realistic total**, and less than P0 alone (83 h).
- **Reuse cuts the work substantially.** D18 (ADR 0031) already shipped KYC, verified caller
  IDs, do-not-call lists, per-country calling windows, a daily outbound cap, outbound
  placement through `RetellGateway.createPhoneCall` (with an agent override, dynamic
  variables, metadata and voicemail detection), and billing for outbound legs. The prompting
  stack, jobs, SSE, notifications, the `DataTable`, and the transcript and recording UI are
  also reusable.
- **What deploys on Thu 5 Nov (realistic: 54 h against 54.5 h):**
  - Live in production behind a `crm` flag: funnels (the default *Inbound Lead Funnel*),
    manual CSV import, the leads board and table, lead detail with timeline, and manual
    stage moves.
  - **Inbound calls attach to the caller's lead**, and the AI reads each call and **suggests**
    field updates and a stage move with quoted evidence, which a person accepts or changes
    in the review queue.
  - Outbound "Call now" from a lead, with the stage-aware agent, verified on staging and
    **dark in production** until counsel signs off.
- **Not in the 5 Nov release:** the automated FIFO dialer with retries and windows, the
  funnel builder, tasks, stuck detection, reports, admin changes and automated intake. They
  follow between 6 and 17 Nov (§9.3).
- **Dialing real leads also has a non-engineering blocker.** ADR 0031 restricts outbound to
  callbacks of prior callers until counsel signs off, and the `outbound_calls` flag stays at
  0 %. Calling consented leads from a list needs a new ADR and the legal sign-off listed in
  spec §17 item 10. That is why the 5 Nov scope puts first what customers can legally use on
  day one: inbound calls are allowed today.

**Recommendation:** deploy the §10 scope on Thu 5 Nov, with the cut list in §9.1 protecting
the date. Plan the **full CRM MVP for Tue 17 Nov**. Live dialing to customers' leads waits
for the legal sign-off.

---

## 2. Assumptions and unclear requirements

Each assumption below is one I made rather than guessed silently. Each one changes the
estimate if it is wrong.

| # | Topic | What the spec or brief says | Assumption used |
| --- | --- | --- | --- |
| A1 | Deadline | "next Thursday, October 29, 2026" | Confirmed with the requester: **next Thursday, 5 Nov 2026, is the production deploy.** (29 Oct is tomorrow.) Code freezes Wed 4 Nov evening; Thursday is regression, deploy, smoke and buffer. |
| A2 | Capacity | — | One developer, AI-assisted, as in CLAUDE.md, at about 10 focused hours a day on weekdays (no weekend commits in the history). A second developer could compress the frontend/backend split by 30–40 % once the shared schemas land (§8). |
| A3 | Companion specs | Spec cites portal spec **v0.4** and admin spec **v0.2** | The repo holds portal **v0.2** and admin **v0.1** (CLAUDE.md source-of-truth table). Appendix D's sync list is treated as the delta. |
| A4 | Outbound model | Spec §2, §14.3: the dialer calls any consented lead | **Conflicts with ADR 0031 §2** ("outbound is a callback", `NO_PRIOR_CONTACT`). A new ADR has to add a *consented-lead* path through `decideOutbound()` with the same gates. Estimated in M0 and M8. |
| A5 | Email-in intake | §6.3: "inbound-mail parsing (already used for support tickets)" | **Not true in this codebase.** Support tickets are created from the portal form (`modules/support`), and no inbound-mail parser exists in `backend/api/src`. Email-in is new infrastructure (MX on a subdomain, an inbound provider, a webhook). |
| A6 | Dialer state | §14.3: Redis sorted set `dialq:{tenant}:{list}`, `active_out:{ws}` | Postgres `call_queue` as the source of truth, with a 10 s scheduler tick under `lock:schedule:dialer`, and the existing `active:{ws}` + `MintSlot` for lines. This follows ADR 0011/0014 and survives a Redis outage. Same effort. |
| A7 | LLM after calls | §9: Anthropic extraction on every reached call | A new *runtime* use of the LLM. ADR 0009 scopes the LLM to brief → prompt. It stays out of the call path, but it needs an ADR amendment and a cost line (one Sonnet call per reached call). |
| A8 | Destinations | Spec examples are Canadian (+1 514) | ADR 0031: platform-bought numbers **dial US destinations only**. Canadian leads need a SIP number. This is a product risk, not an estimate line. |
| A9 | Routes | `/app/leads/[id]`, `/app/leads/funnels/[id]` | Static export: `/app/leads/?id=` and `/app/leads/funnels/?id=` (ADR 0018 pattern). |
| A10 | Spec field names | `tenants.outbound_enabled`, `phone_numbers.verified_caller_id`, global `dnc_entries` | Already exist as `tenants.kyc_status` + the `outbound_calls` flag, `phone_numbers.caller_id_verified_at`, and `dnc_entries` (workspace) + `blocklists` (platform). Reuse; no new columns. |
| A11 | "Verified caller ID" fee (§11) | Retell $10 → 15 credits one-time | Our caller-ID verification is free and automatic for bought numbers (ADR 0031 §1). A paid platform caller-ID product is unverified and P2. |
| A12 | Open decisions (§17) | 11 items | Recommended defaults used everywhere: name **Leads**, four templates in P1, Reached kept separate, email-in only in P1, 0.80 threshold, hang up on voicemail, inbound auto-create on. |
| A13 | Spec maturity | v0.2, dated today, untracked in git | Expect churn. The worst case carries rework for it. |

---

## 3. Specification breakdown

The spec, broken into implementable modules. "§" refers to `oraly-crm-spec.md`.

| ID | Module | Spec | Contents |
| --- | --- | --- | --- |
| M0 | Decisions + ADR 0033 | §2, §17, §15 | The 11 decisions, the consented-lead outbound path (vs ADR 0031), the post-call LLM (vs ADR 0009), CLAUDE.md invariants |
| M1 | Data model, RLS, schemas | §12 | 17 new tables (`funnels, stages, contacts, leads, lead_lists, intake_channels, import_jobs, import_rows, call_queue, dial_attempts, stage_history, review_items, lead_activities, tasks, playbooks, consent_records, funnel_templates`), plus `calls.lead_id`, `calls.dial_attempt_id`, `agents.funnel_id`, `agent_versions.playbook_version`. RLS policies, grants, append-only `stage_history`/`lead_activities`, and zod in `@portal/schemas` |
| M2 | Funnel and stage API + templates | §5.1–5.5, §13 Funnels, App. A | `inbound_lead`, `outbound_list`, `quote`, `appointment` templates; default funnel per workspace; stage CRUD/reorder/validate (3–12 stages, exactly one won and one lost) |
| M3 | Funnel builder UI (C6) | §10 C6 | Funnel list, stage strip, stage editor (goal, exit criterion, capture fields, must-not, call behaviour, stuck, time rule, SLA), funnel settings, playbook preview |
| M4 | Leads core API | §5.5, §13 Leads | List/board grouping and filters, create, patch, manual stage move, notes, timeline, bulk, export, DNC, delete, merge |
| M5 | Board, table, lead detail (C1, C2) | §10 C1–C2 | Kanban by stage, card chips, move with confirmation, table with filters and bulk actions, lead detail with funnel panel, card fields, timeline |
| M6 | Manual CSV/XLSX import (C3) | §6.1, §6.2, §6.4, §14.1, App. B | Upload, header-synonym mapping, phone normalisation, validation, dedupe modes, consent check, error CSV, batched idempotent commit job, template CSV |
| M7 | Lists and call rules (C4, C5) | §7.1, §10 C4–C5 | `lead_lists`, rules JSON, playbook defaults per funnel type, list pause/resume/archive, simulate |
| M8 | Rules engine + dialer | §7.2–7.3, §14.2–14.3 | Ordered checks, FIFO per list, retries at the head, cadence, lead-TZ windows over legal floors, daily cap, credits, inbound reserve, round-robin across lists, outcome classification, `window-opener`, `list-finisher` |
| M9 | Stage-aware outbound agent | §8 | `lead_followup` / `appointment_outbound` templates, the "Stage playbook" section in generation, per-dial dynamic variables, "Republish needed" |
| M10 | Post-call processor | §5.6, §9, §14.4, App. C | Outcome classification, Anthropic structured extraction, guard rails in code, apply vs review, field confidence, next action, idempotent on `call_id`, accuracy check on 20 transcripts (§16 P0 exit: ≥ 85 %) |
| M11 | Review queue (C8) | §10 C8 | Items, accept / override / keep / stuck / lost, bulk accept |
| M12 | Tasks (C9) + Home tiles | §10 C9, App. D | Tasks CRUD, "Tasks due today" and "Needs review" on D1 |
| M13 | Stuck, time rules, hand-offs | §5.5, §5.7, §14.5 | `stuck-detector`, `time-rules`, `handoffs` jobs, stuck playbook |
| M14 | Inbound-to-lead matching | §14.6 | Inbound `call_analyzed` → contact by `from_number` → attach and judge, or create a lead in the default funnel |
| M15 | Dialer live view (C7) | §10 C7 | Calling now, queued, blocked reasons, pause all, concurrency; SSE `dialer` |
| M16 | Funnel reports (C10) | §5.9, §10 C10 | Funnel, velocity, speed-to-lead, reach, drop-off, stuck heatmap, cost, AI accuracy, list comparison, CSV per block |
| M17 | Automated intake | §6.3 | Email-in, scheduled fetch, signed drop endpoint (the lead form is spec P2) |
| M18 | Plan limits and gates | §5.10, §11 | Funnels, stages, fields, leads stored, daily dials, intake gates in `pricingConfig` + enforcement |
| M19 | Admin additions | App. D | SA2 "Leads & dialing" tab, SA5 limit fields, SA6 funnel template catalogue, SA12 "Pause all outbound" kill switch |
| M20 | Notifications | §9.2 step 8, §14.5 | Owner alerts (stage entry, stuck, list finished/paused), digest section |
| M21 | Compliance additions | §15 | `consent_records`, per-list attestation, DNC on request inside the post-call job, recording-consent keyed on the lead's region, `dnc.scrub()` stub, `crm-reconcile` |
| M22 | i18n | CLAUDE.md portal rules | Every CRM string in `en`, `ar`, `fr-CA`; RTL-safe board |
| M23 | OpenAPI contract | CLAUDE.md API conventions | Manifest entries for about 71 routes, `openapi:generate`, typed client |
| M24 | Cross-cutting e2e | CLAUDE.md working agreements | RLS matrix over the new tables, dial → bill → move exactly once, no dial outside window or consent |
| M25 | Staging verification | §16 P0 | Real `create-phone-call` with stage variables, outbound disconnection reasons, unanswered dial billed 0, voicemail flag |
| M26 | Docs | CLAUDE.md | CLAUDE.md, ADRs, spec-extract, tasks plan |

---

## 4. Existing functionality vs new development

### 4.1 Reused as-is or with small extensions (evidence in the repo)

| Spec need | Already in Oraly | Where | Gap |
| --- | --- | --- | --- |
| Place an outbound call with an agent, stage variables and metadata | `RetellGateway.createPhoneCall` takes `agentId`, `agentVersion`, `metadata`, `dynamicVariables`, `voicemail`, `maxCallDurationMs` | `backend/api/src/modules/retell/retell.gateway.ts:244` | None for placement |
| KYC gate, verified caller ID | `tenants.kyc_status`, `phone_numbers.caller_id_verified_at`, `guard_outbound_verdicts` trigger, staff verdict routes, portal Settings → Outbound | ADR 0031 §1, `modules/outbound`, migration `20261028090000_p2_outbound_compliance` | None |
| DNC (workspace + global) | `dnc_entries` + `blocklists` (type `phone`), `GET/POST/DELETE /dnc` | `modules/outbound/dnc.service.ts` | Add "DNC on request" from the post-call job |
| Legal calling-hour floors per country, every-zone rule | `outbound.countries` in `pricingConfig`, `calling-window.ts` (`localClock`, no DST modelling) | `shared/schemas/src/outbound.ts`, `modules/outbound/calling-window.ts` | Add a lead-TZ customer window that can only narrow it |
| Gate ordering as a pure function | `decideOutbound()` | `modules/outbound/outbound.decide.ts:44` | Add a consented-lead variant (consent replaces `NO_PRIOR_CONTACT`) — needs ADR 0033 |
| Daily outbound cap under a lock | `pg_advisory_xact_lock('outbound:<ws>')` over `outbound_calls` | `outbound.service.ts` `claimAttempt` | Count dialer attempts in the same cap |
| Concurrency, inbound share | `active:{ws}` + `MintSlot` + `RESERVE_SCRIPT` | `modules/calls/call-headroom.ts` | Inbound reserve = reserve fewer outbound lines |
| Billing of outbound legs, unanswered = 0 | `call_ended` metering, `disconnection_reason` not-connected = 0, `recordOutboundPlaced` | `modules/calls/metering.ts`, ADR 0031 | None — credits per lead/list are reads over `calls` |
| Lost lifecycle webhooks | `call-recovery`, `reconciliation_runs` | ADR 0011 §7, ADR 0014 | `crm-reconcile` is a thin extension |
| Anthropic structured output, test stand-in | `PromptProvider` (Anthropic + `ScriptedPromptProvider`), zod gate on model output | `modules/prompting/providers/` | New `extractCall()` method + schema (Appendix C) |
| Agent templates and generation | Template loader shared by seed and API; generation worker; `lead_qual` template (inbound) | `templates/`, `@portal/db` loader, `prompting` | New `lead_followup` / `appointment_outbound`, stage-playbook section |
| Recording-consent line | `prompting/recording-notice.ts` | — | Key on the lead's region |
| Jobs, schedules, 202 + job watch | 5 BullMQ queues, 14 schedules under `lock:schedule:{name}`, `jobs` table | `modules/jobs`, `modules/scheduled` | 7–10 new handlers |
| Real-time updates | `events:{ws}` pub/sub, `GET /events?topics=`, `DashboardLiveProvider` + event bus | `modules/events`, `frontend/web/src/dashboard/use-live-events.ts` | New topics `dialer`, `lead:{id}`, `list:{id}`, `funnel:{id}`, `review` |
| Notifications and digest | Outbox, keyed `alerts`, per-timezone hourly digest | ADR 0014, `modules/notifications` | Add CRM sections |
| Plan caps, flags, kill switches | Versioned `pricingConfig`, `feature_flags` with rollout, kill switches | `shared/schemas/src/pricing.ts`, `modules/config` | Add CRM caps, a `crm` flag, `pause_outbound` |
| Tables on desktop and phone, confirmations | `DataTable` (cards below 640 px), `ConfirmDialog`, `useRole()`, `useUrlQuery` | `frontend/web/src/components/dashboard/` | Board is new |
| Transcript viewer, recording player | D2 call detail, signed recording proxy | `frontend/web/app/app/calls`, ADR 0011 §5 | Reuse in C2 and C8 |
| Streamed, formula-safe CSV export | `POST /calls/export`, `modules/calls/csv.ts` | — | Lead export reuses the pattern |
| Phone parsing | `libphonenumber-js` (API), `captured-phones.ts` | `backend/api/package.json` | Import normalisation reuses it |
| SSRF guard for customer URLs | Knowledge URL sources refuse private hosts | `modules/knowledge` | Reuse for scheduled fetch |
| Public token endpoints with budgets | Widget `/widget/:key`, per-IP and per-key windows | `modules/calls/widget.*`, ADR 0029 | Reuse for `POST /intake/:token` |
| Audit | `audit_log`, `staff_audit_log` in the write's transaction | ADR 0006, ADR 0021 | Every CRM write follows the same rule |

### 4.2 New development (nothing to reuse)

- **All 17 CRM tables** and their RLS policies, grants and triggers.
- **CSV/XLSX parsing.** `modules/calls/csv.ts` only writes CSV. There is no parser and no
  XLSX library in `backend/api/package.json`.
- **Kanban board with drag.** No drag-and-drop library in `frontend/web/package.json`. Use
  native drag on desktop plus a "Move to…" menu, which also covers phone and RTL.
- **The dialer** (queue, cadence, retries, fairness, finishing lists).
- **The post-call judge** (extraction, guard rails, review queue). Model output is gated by
  zod exactly like `generatedPrompt` today.
- **Inbound email intake**, which the spec wrongly assumes exists (A5).
- **Reports C10.** Nothing in `GET /stats` covers cohorts or stage conversion.
- **Admin SA2/SA5/SA6/SA12 additions.**

### 4.3 Duplication to avoid

- Do **not** add `tenants.outbound_enabled`, `phone_numbers.verified_caller_id` or a second
  `dnc_entries` (A10).
- Do **not** add a second outbound placement path or a second set of gates. Extend
  `decideOutbound()` and `OutboundService` with a lead source.
- Do **not** add `active_out:{ws}`. Use `active:{ws}` and `MintSlot` (A6).
- Do **not** add a second digest job. Extend the per-timezone digest.

---

## 5. Task-by-task estimates

### 5.1 How the hours were calibrated

All hours are **focused, AI-assisted developer hours**, the unit `docs/plan/tasks.csv` uses
(one "D-day" = 8 h). The last three milestones were planned at 8 h each and delivered at
that pace:

| Milestone | Commit | Delivered | Size |
| --- | --- | --- | --- |
| D16 transfer billing, hours, KB stats, SIP | `4adaa0a` | 27 Oct, 12:46 | 84 files, +8,217 |
| D17 call my phone, forwarding test, widget | `ccc25f5` | 27 Oct, 14:54 | 73 files, +4,401 |
| D18 outbound + compliance (+ 28 Oct QA batch) | `8a8889c` | 28 Oct, 12:56 | 177 files, +15,670 (outbound module 1,347 lines + a 644-line e2e suite) |

Each module was sized against the nearest comparable piece of this repo. For example, M8
(dialer) was sized against D18's gates plus the inbound reservation path, and M6 (import)
against D10's calls list and CSV export. Three kinds of work **do not compress** with AI
assistance, so they are counted at wall-clock time: labelled-transcript accuracy
evaluation (M10), real-call verification on staging (M25), and decisions (M0).

**Without AI assistance, multiply by about 2.5–3.** That lands near the spec's own
"6–8 weeks for P1".

### 5.2 Per-module estimate

FE = frontend, BE = backend/API, DB = database and migrations, Int = integration,
configuration and docs, Test = tests and bug-fixing. The split columns add up to the
realistic figure.

| ID | Module | FE | BE | DB | Int | Test | **Best** | **Realistic** | **Worst** | Priority | Complexity | Depends on | Main risk |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --- | --- | --- | --- |
| M0 | Decisions + ADR 0033 | – | – | – | 2 | – | 1 | **2** | 4 | P0 | Low (but blocking) | Pramod, counsel | Decisions not made in time |
| M1 | Data model, RLS, schemas | – | 1 | 3 | – | 1 | 3 | **5** | 8 | P0 | Medium | M0 | 17 tables × RLS/grants; migration ordering |
| M2 | Funnel/stage API + templates | – | 2.5 | 0.5 | – | 1 | 2 | **4** | 6 | P0 | Medium | M1 | Stage invariants (one won, one lost, delete-if-empty) |
| M3 | Funnel builder UI (C6) | 4 | – | – | – | 1 | 3 | **5** | 8 | P1 | Medium | M2 | Large form, capture-field editor |
| M4 | Leads core API | – | 3.5 | – | – | 1.5 | 3 | **5** | 8 | P0 | Medium | M1, M2 | Board grouping + filters + cursor pages |
| M5 | Board, table, lead detail (C1, C2) | 6 | – | – | – | 1 | 4 | **7** | 11 | P0 | Medium-high | M4 | Kanban on phone and in RTL |
| M6 | CSV/XLSX import (C3) | 3 | 3.5 | 0.5 | – | 1 | 5 | **8** | 13 | P0 | Medium-high | M1, M4 | 10 k-row files, encodings, dedupe modes |
| M7 | Lists + call rules (C4, C5) | 2.5 | 1.5 | – | – | 1 | 3 | **5** | 8 | P1 (lists P0) | Medium | M6 | Rules form breadth |
| M8 | Rules engine + dialer | – | 5 | 0.5 | 1.5 | 2 | 5 | **9** | 15 | P0 | **High** | M0, M6, M9 | Double dials, FIFO under retries, lead-TZ windows |
| M9 | Stage-aware outbound agent | – | 2 | – | 1 | 1 | 2 | **4** | 6 | P0 | Medium | M2 | Prompt quality per stage |
| M10 | Post-call processor | – | 5 | – | 1 | 7 | 7 | **13** | 24 | P0 | **High** | M2, M9 | ≥ 85 % decision accuracy; no labelled transcripts exist yet |
| M11 | Review queue (C8) | 2 | 1 | – | – | 1 | 2 | **4** | 6 | P0 | Low-medium | M10 | — |
| M12 | Tasks (C9) + Home tiles | 1.5 | 1 | – | – | 0.5 | 2 | **3** | 5 | P1 | Low | M4 | — |
| M13 | Stuck, time rules, hand-offs | 0.5 | 3.5 | – | – | 1 | 3 | **5** | 8 | P1 | Medium | M10, M12 | Rule interactions |
| M14 | Inbound-to-lead matching | – | 1.5 | – | – | 0.5 | 1 | **2** | 4 | P0 | Low-medium | M4 (M10 for judging) | Number formats on caller ID |
| M15 | Dialer live view (C7) + SSE | 1.5 | 1 | – | – | 0.5 | 2 | **3** | 5 | P1 | Low | M8 | — |
| M16 | Funnel reports (C10) | 3.5 | 3 | 0.5 | – | 1 | 5 | **8** | 14 | P1 (3 blocks) / P2 (6 blocks) | Medium-high | M8, M10 | Cohort SQL on large tables |
| M17 | Automated intake | 2 | 5 | – | 2.5 | 1.5 | 6 | **11** | 20 | P2 (email-in P1) | High | M6 | Inbound mail provider + DNS; SSRF |
| M18 | Plan limits and gates | 0.5 | 1.5 | – | – | 1 | 2 | **3** | 5 | P1 | Low | M1 | Pricing config migration |
| M19 | Admin additions | 3 | 2 | – | – | 1 | 4 | **6** | 10 | P1 | Medium | M8, M18 | Staff audit rule on every write |
| M20 | Notifications | – | 1.5 | – | – | 0.5 | 1 | **2** | 3 | P1 | Low | M10, M13 | — |
| M21 | Compliance additions | – | 2 | – | – | 1 | 2 | **3** | 5 | P0 | Medium | M8, M10 | Legal wording pending |
| M22 | i18n (ar, fr-CA) | 5 | – | – | – | – | 3 | **5** | 8 | P0 (per shipped screen) | Low | each FE module | `messages.test.ts` fails on a missing key |
| M23 | OpenAPI contract | – | – | – | 1 | – | 1 | **1** | 2 | P0 | Low | each BE module | `openapi:check` in CI |
| M24 | Cross-cutting e2e | – | – | – | – | 4 | 2 | **4** | 7 | P0 | Medium | all | Suites run one at a time (slow) |
| M25 | Staging real-call verification | – | – | – | 4 | 2 | 3 | **6** | 12 | P0 | Medium | M8–M10 | US-only destinations; carrier spam labels |
| M26 | Docs | – | – | – | 1 | – | 1 | **1** | 2 | P0 | Low | all | — |
| | **Total** | **35** | **47** | **5** | **14** | **33** | **78** | **134** | **227** | | | | |

### 5.3 Totals

| | Best | Realistic | Worst |
| --- | --: | --: | --: |
| P0 — usable CRM (dialing + AI judging) | 47 h | 83 h | 141 h |
| P1 — should have | 25 h | 40 h | 66 h |
| P2 — can wait (automated intake) | 6 h | 11 h | 20 h |
| **Whole MVP** | **78 h** | **134 h** | **227 h** |
| By discipline (realistic) | FE 35 · BE 47 · DB 5 · Int 14 · Test 33 | | |
| Calendar, one developer, about 10 h a day from today (+ the 5 Nov release day) | **Mon 9 Nov** | **Tue 17 Nov** | **Mon 30 Nov** |
| Without AI assistance (× 2.5–3, cross-check vs spec §16) | ~4–5 wks | ~8–10 wks | ~14–17 wks |

The worst case includes spec churn (A13), the accuracy loop in M10 needing several prompt
iterations, and a dialer bug found on staging.

**Live dialing to real leads** additionally needs counsel's sign-off on consent wording,
calling hours, DNC scrubbing and the recording line (§17 item 10, ADR 0031 §3–§4). That is
outside the engineering calendar.

---

## 6. P0 / P1 / P2

### P0 — Must have (a usable CRM: import → dial → judge → board)

M0 decisions and ADR · M1 data model · M2 funnels with the `inbound_lead` template
(`outbound_list` is a copy of it) · M4 leads API · M5 board, table, detail · M6 manual CSV
import (XLSX allowed to slip to P1) · lists as created by import (part of M7) · M8 rules
engine and dialer (FIFO, window, retries, max attempts, daily cap, credits, concurrency 1
by default) · M9 `lead_followup` agent with the stage playbook · M10 post-call processor
with code guard rails · M11 review queue · M14 inbound matching · M21 consent and DNC ·
M22 i18n of what ships · M23 · M24 · M25 · M26.

### P1 — Should have

M3 full funnel builder (P0 ships template stages with rename and goal edits only) · M7
rules screen, per-list overrides, simulate · M12 tasks + Home tiles · M13 stuck detection
and playbook, time rules, hand-offs · M15 dialer live view · M16 reports: funnel,
reach, drop-off · M18 plan limits · M19 admin Leads & dialing tab, SA5 limits,
`pause_outbound` kill switch · M20 notifications · `quote` and `appointment` templates ·
email-in intake (decision §17.4) · XLSX import.

### P2 — Can wait

M17 scheduled fetch and drop endpoint, the Oraly lead form · reports: velocity,
speed-to-lead, stuck heatmap, cost, AI accuracy, list comparison · "Test with a
transcript" · playbook simulate · SA6 funnel-template catalogue editing (templates ship as
files, like agent templates) · `reengagement`, `inbound_calls` and industry variants ·
voicemail drop · merge leads · per-workspace rubric tuning · list A/B of agents. All of
these match the spec's own §16 P2 list.

---

## 7. Risks and blockers

| # | Risk | Impact | Likelihood | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | **Legal sign-off** on consent, calling hours, DNC scrubbing, recording line (§17.10, ADR 0031 §3–4) | Dialing real leads cannot be switched on, whatever is built | **High** | Build behind the `outbound_calls` flag at 0 %. Demo on staging to the team's own consented numbers. Start counsel now. |
| R2 | **ADR 0031 conflict**: outbound is callback-only by design | A dialer that bypasses `decideOutbound()` is a compliance hole | Certain (needs a decision) | ADR 0033: a *consented lead* is a second allowed source *inside* the same gate function, with consent replacing prior contact and every other gate unchanged |
| R3 | **Stage-decision accuracy** (§16 P0 exit ≥ 85 %; P1 ≥ 90 %) | Wrong moves erode trust | Medium-high | Code guard rails (§5.6.3), a high auto-apply threshold, everything else to review. Needs 20 labelled transcripts — none exist yet (outbound has never run). Make them from staging calls. |
| R4 | **Double dial / out-of-order dial** | TCPA exposure, credit waste | Medium | A Postgres row lock on `call_queue` claims, an idempotency key per attempt, `MintSlot` before the platform, an e2e test under concurrent ticks |
| R5 | **US-only destinations** from platform numbers (ADR 0031) | Canadian design partners cannot dial leads from bought numbers | High for CA | Verify on staging. SIP numbers for CA. State it in the product copy. |
| R6 | **No inbound-mail infrastructure** (A5) | Email-in is not "reuse" | Certain | Move email-in to P1 at the earliest; needs an inbound provider, MX on `in.oraly.ai`, a webhook, SSM secrets via `ssm-put-env.sh` |
| R7 | **Spec maturity** — v0.2 from today, 11 open decisions, companion specs not in the repo | Rework | High | Lock the P0 decisions with Pramod before writing migrations (M0) |
| R8 | **Post-call LLM cost and latency** (§16: reach → card < 90 s) | Margin, SLA | Medium | Its own queue (like `prompting`, ADR 0012 §6), 20 s timeout and one retry (§14.4), a cost line per reached call in COGS |
| R9 | **Import scale** (10 k rows, encodings, semicolons, XLSX) | Timeouts, memory | Medium | Parse in the worker, 500-row transactions (§14.1), an XLSX library (exceljs) added after a licence check |
| R10 | **Kanban on phones and in RTL** | Unusable on mobile | Medium | "Move to…" menu as the primary action, drag as a desktop enhancement; logical CSS only |
| R11 | **Capacity shared with QA batches** (8 commits today, mostly QA) | Every QA hour comes off the CRM | High | Freeze non-blocking QA until the foundation lands |
| R12 | **i18n triple cost** | About 15 % on every FE task | Certain | Counted in M22; write keys once, translate in batches |
| R13 | **Carrier "Spam likely" labelling** on new numbers | Low reach rate | Medium | Out of our code; branded caller ID is P2 (§15) |

### External dependencies and configuration

| Dependency | Needed for | Status |
| --- | --- | --- |
| Counsel (Michael) | Live dialing of leads | Pending (ADR 0031) |
| Pramod | §17 decisions, ADR 0033 | Not started |
| Retell `create-phone-call` with dynamic variables | M8, M9 | Wrapped in the gateway; outbound shape partly verified in D18 |
| Anthropic API key on worker | M10 | Exists for generation |
| Inbound email provider + DNS (MX) | Email-in (P1) | Not provisioned |
| XLSX parser package | M6 XLSX | Not installed |
| Labelled transcripts | M10 accuracy exit | None exist |

---

## 8. Parallel work and dependencies

```
M0 decisions ──► M1 schema + zod ──┬─► M2 funnels API ──► M3 builder UI (P1)
                                   │          │
                                   │          └─► M9 outbound agent ─┐
                                   ├─► M4 leads API ──► M5 board/detail
                                   │          └─► M14 inbound match  │
                                   └─► M6 import ──► M7 lists ──────►┴─► M8 dialer ──► M25 staging calls
                                                                          │
                                                       M9 + M2 ──► M10 post-call ──► M11 review
                                                                          └─► M13 stuck/time ─► M20 notify
                                       M8 + M10 ──► M15 live view · M16 reports · M19 admin
```

- **Serial spine:** M0 → M1 → (M4, M6) → M8 → M10. The zod schemas in `@portal/schemas`
  are the contract. Once they land, frontend and backend run in parallel.
- **Parallel once M1 lands:** M2 ∥ M4 ∥ M6 (backend), and M5 ∥ C3 UI (frontend) against
  the schemas. M9 ∥ M8. M16 ∥ M19 ∥ M13 after M10.
- **Can start immediately, independent of code:** counsel review (R1), labelling
  transcripts (R3), choosing an inbound-mail provider (R6).

---

## 9. Day-by-day plan to the 5 November deploy

**Capacity:** Wed 28 Oct afternoon (≈ 4.5 h) + Thu 29 Oct – Wed 4 Nov (5 working days ×
10 h) = **54.5 build hours**. **Code freeze Wed 4 Nov, 19:00.** Thu 5 Nov is release day:
regression, production deploy, smoke test, and buffer for hotfixes.

### 9.1 Scope for 5 Nov, and the order of work

**The ordering principle:** what customers can use in production on day one comes first.
In production the `outbound_calls` flag stays at 0 % until counsel signs off (R1), so
dialing is dark there whatever we build. Inbound calls are legal today, so inbound matching
plus AI suggestions deliver live value on 5 Nov. Outbound is built and proven on staging so
it can be switched on when the sign-off arrives.

| Block | Modules | Best | Realistic | Worst |
| --- | --- | --: | --: | --: |
| Foundation: data model, default funnel, CSV import, board/table, lead detail, manual moves | M1 core, M2 (template only), M4, M5, M6 (CSV) | 10.25 | 15 | 26.5 |
| ADR 0033 (consented-lead outbound path) + ADR 0009 amendment (post-call LLM) | M0 | 1 | 2 | 4 |
| Remaining P0 tables (`review_items`, `dial_attempts`, `call_queue`, `consent_records`) | M1 rest | 1 | 2 | 3 |
| Inbound calls attach to their lead | M14 | 1 | 2 | 4 |
| Post-call AI: extraction, code guard rails, suggestions (**auto-apply off at launch**) | M10 without the accuracy loop | 4 | 7 | 12 |
| Review queue (C8) | M11 | 2 | 4 | 6 |
| Stage-aware `lead_followup` agent | M9 | 2 | 4 | 6 |
| "Call now" per lead through the consented-lead gate; consent records; DNC on request | M8 (part), M21 | 3 | 6 | 10 |
| Staging real-call verification | M25 | 3 | 6 | 12 |
| Cross-cutting e2e, i18n sweep, OpenAPI, docs | M22–M24, M26 | 3 | 6 | 10 |
| **Total** | | **30.25** | **54** | **93.5** |

**What this means:**

- **Realistic:** 54 h against 54.5 h of capacity. It fits with about half an hour of slack.
- **Best case:** about 24 h are left over. The stretch list below uses them, in order.
- **Worst case:** about 39 h over, so the cut list applies.

**Auto-apply is off at launch** (every stage suggestion goes to review). That takes the
§16 accuracy exit (≥ 85 % on 20 labelled transcripts) off the release path. It decides
when auto-apply is switched on, not whether the CRM ships.

**If the week slips, cut in this order** (first to last):

1. Staging verification, "Call now" and the outbound agent. They are dark in production
   anyway; move them to 6–9 Nov.
2. Review-queue extras: bulk accept and keyboard shortcuts.
3. Drag on the board. Keep the "Move to…" menu.
4. Import mapping overrides. Keep auto-mapping.

**Never cut:** the RLS tests, the `ar`/`fr-CA` keys (CI and `messages.test.ts` fail
without them), or the code guard rails on AI decisions.

**If ahead of plan, add in this order:**

1. The automated dialer: FIFO tick, retries, lead-TZ windows (≈ 6 h on top of "Call now").
2. Tasks + Home tiles (3 h).
3. The funnel builder (5 h).

### 9.2 Day by day

| Day | Hours | Work | Exit check for the day |
| --- | --: | --- | --- |
| **Wed 28 Oct** | 4.5 | Confirm this scope and §17 decisions 1, 2, 3, 6, 9 with Pramod (0.5). Migration: all P0 tables + `calls.lead_id`, RLS, grants, append-only triggers on `stage_history` / `lead_activities` (4) | Migration applies on a fresh database; the RLS test passes |
| **Thu 29 Oct** | 10 | Zod schemas, `inbound_lead` template, default funnel on first open (1). Funnels + leads API: board grouping, table page, detail, create, patch, manual move, notes (2). CSV import API: delimiter detection, header synonyms, phone normalisation, consent flag, duplicate = skip + note, 500-row transactions, idempotent on `import_job_id + row_no` (2). Board with "Move to…" + table on `DataTable` (2). Lead drawer (1.5). Import screen (1.5) | A 500-row CSV imported locally shows on the board in file order |
| **Fri 30 Oct** | 10 | `ar` / `fr-CA` keys, `openapi:generate`, foundation e2e (2). Deploy the foundation to staging (1). ADR 0033 + ADR 0009 amendment (2). Inbound matching (2). Extraction schema (App. C), `PromptProvider.extractCall`, scripted stand-in (3) | Foundation on staging; an inbound staging call appears on its lead's timeline |
| **Mon 2 Nov** | 10 | Post-call guard rails (§5.6.3), suggestions with evidence, field confidence ("unconfirmed"), timeline entry, idempotent on `call_id`, own queue (4). Review queue API + screen (4). `lead_followup` template (2) | An inbound staging call produces a reviewable stage suggestion |
| **Tue 3 Nov** | 10 | Stage playbook + per-dial dynamic variables (2). "Call now" through the consented-lead gate in `decideOutbound()`, `consent_records`, DNC on request from the post-call job (6). First staging calls to team numbers (2) | A lead is rung from staging; the call lands on its timeline with a suggestion in review |
| **Wed 4 Nov** | 10 | Staging verification: outbound disconnection reasons, unanswered dial billed 0, voicemail flag (4). Cross-cutting e2e: RLS matrix over the new tables, post-call exactly once, no dial without consent or outside the window (4). i18n sweep, CLAUDE.md, ADRs, spec-extract (1.5). **Code freeze 19:00** (0.5) | All suites green; staging signed off |
| **Thu 5 Nov** | release | 09:00 regression on staging. **Production deploy:** additive migration; `crm` flag on for the chosen workspaces; `outbound_calls` stays at 0 %. Production smoke test: import, board, inbound match, review. Afternoon: buffer and hotfixes | **CRM first release live in production** |

### 9.3 After 5 Nov, to the full MVP (realistic Tue 17 Nov)

| Day | Focus | Modules |
| --- | --- | --- |
| Fri 6 Nov | Accuracy run on labelled transcripts; decide the auto-apply threshold | M10 |
| Mon 9 Nov | Automated dialer: FIFO tick, retries, lead-TZ windows, `window-opener`, `list-finisher` | M8 |
| Tue 10 Nov | Funnel builder C6; lists + call rules C4/C5 | M3, M7 |
| Wed 11 Nov | Tasks + Home tiles; stuck detector + playbook; time rules; hand-offs | M12, M13 |
| Thu 12 Nov | Dialer live view; notifications and digest; plan limits | M15, M20, M18 |
| Fri 13 Nov | Reports (funnel, reach, drop-off); XLSX import | M16, M6 |
| Mon 16 Nov | Admin: Leads & dialing tab, limits, `pause_outbound` | M19 |
| Tue 17 Nov | e2e, i18n sweep, docs, staging regression, deploy | M22–M24, M26 |

Best case about Mon 9 Nov, worst case about Mon 30 Nov. Email-in and the remaining report
blocks follow if §17.4 keeps them in. Live dialing for customers is switched on when
counsel signs off.

---

## 10. Deliverables for Thursday 5 November

**Live in production** (behind the `crm` feature flag, enabled per workspace):

- A default **Inbound Lead Funnel** per workspace with the Appendix A.1 stages.
- **Manual CSV import:** upload, auto-mapping with overrides, phone normalisation,
  consent flag ("No consent" leads are imported and marked), duplicate skip with a note,
  rows kept in file order (`position`).
- A **board** by stage with "Move to…", and a **table** with stage and list filters.
- **Lead detail:** contact, funnel path, fields with their origin, timeline (import, calls,
  stage moves, notes), add note.
- **Manual stage moves**, recorded in `stage_history` and `lead_activities`.
- **Inbound calls attach to the caller's lead** by phone number, or create a lead in the
  default funnel (§14.6).
- **AI reads every attached call:** a summary, field updates (shown as "unconfirmed"), and
  a stage suggestion with quoted evidence, going to the **review queue**, where a person
  accepts, changes or rejects it. The code guard rails of §5.6.3 apply. Auto-apply is off.

**Built and verified on staging, dark in production until counsel signs off:**

- The stage-aware `lead_followup` agent.
- "Call now" on a lead, through the same `decideOutbound()` gates with consent in place of
  prior contact.
- Consent records, and DNC on request from the call.

**Database:** 12 new tables (`funnels`, `stages`, `contacts`, `leads`, `lead_lists`,
`import_jobs`, `stage_history`, `lead_activities`, `review_items`, `dial_attempts`,
`call_queue`, `consent_records`) + `calls.lead_id`. Additive migration only.

**API:** about 25 routes (funnels read, leads, stage move, notes, imports, review, call
now), in the OpenAPI manifest and the generated client.

**Screens:** `/app/leads/` (board and table), the lead drawer, `/app/leads/import/`,
`/app/leads/review/`, in `en`, `ar` and `fr-CA`.

**Testing:**

- e2e: RLS isolation on every new table; import order and idempotency; manual-move
  history; viewer role; post-call processed exactly once per call; no dial without consent
  or outside the window; every outbound refusal audited with nothing placed.
- Unit tests: header mapping, phone normalisation, the guard rails.
- Real calls on staging.

**Postponed (target dates from §9.3):**

| Item | Target |
| --- | --- |
| Auto-apply decision | 6 Nov |
| Automated dialer | 9 Nov |
| Funnel builder and call rules | 10 Nov |
| Tasks, stuck detection, time rules, hand-offs | 11 Nov |
| Live view, notifications, limits | 12 Nov |
| Reports, XLSX | 13 Nov |
| Admin additions | 16 Nov |
| Automated intake | after 17 Nov |
| Every P2 item | later |
| Live dialing to customers' leads | after counsel sign-off |

---

## 11. Final recommendation

1. **The full CRM by Thu 5 Nov is not achievable.** The evidence: 134 realistic hours
   against 54.5 build hours, P0 alone at 83 h, and a legal gate on dialing that engineering
   cannot close.
2. **Deploy the §10 scope on 5 Nov.** It fits the realistic estimate with almost no slack,
   so the §9.1 cut list is what protects the date. If the week slips, outbound goes first,
   because it is dark in production anyway.
3. **Put live value first.** Inbound matching plus AI suggestions are usable by every
   customer on day one without counsel. Outbound ships ready and switched off.
4. **Unblock the non-code items today:**
   - Pramod: the §17 decisions and ADR 0033.
   - Counsel: consent wording, calling hours, DNC scrub, recording line.
   - Labelled transcripts: 20 of them, for the auto-apply decision on 6 Nov.
   - Canadian destinations: confirm whether Canadian leads must be dialled from bought
     numbers (R5).
5. **Protect capacity.** Pause non-blocking QA work until 5 Nov. If a second developer is
   available, put them on the frontend (board, import, review queue) once the shared
   schemas merge on Thu 29 Oct. That turns the zero-slack plan into one with a day of
   margin.
