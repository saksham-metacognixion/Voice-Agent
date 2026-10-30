# Oraly CRM — Funnels & Lead Management Module Specification

| | |
|---|---|
| **Product** | Oraly (the voice-agent portal specified in `voice-agent-portal-spec.md`) |
| **Module** | CRM — a core system inside Oraly, not a separate product |
| **Companions** | `voice-agent-portal-spec.md` v0.4 (agents, numbers, wallet, metering) · `super-admin-spec.md` v0.2 (pricing, limits, compliance gate, support) |
| **Owner** | Pramod (CTO) |
| **Date** | 28 Oct 2026 |
| **Version** | v0.2 — funnels specified in full (§5); "pipeline" renamed to "funnel" throughout |
| **Hard constraint** | No integrations with external products. Leads enter by CSV (manual or automated), everything else happens inside Oraly. |

## Table of contents

1. Summary and scope boundary
2. Framing correction: "inbound funnel", outbound calls, and consent
3. Concepts and vocabulary
4. End-to-end flow
5. **Funnels** — anatomy, the two primary funnels, template library, stages, movement rules, AI judgement, stuck handling, metrics
6. Lead intake — CSV import (manual and automated)
7. Call rules and calling sequence
8. The outbound agent (stage-aware)
9. Post-call processing: card update, stage movement, stuck detection
10. Screens (C1–C10)
11. Credits, limits and plan gates
12. Data model
13. API surface
14. Backend flows and jobs
15. Compliance and abuse controls
16. Phasing
17. Decisions needed
Appendix A — Funnel templates with full stage definitions · B — CSV template and column mapping · C — Post-call extraction schema · D — Sync list for the other two specs

---

## 1. Summary and scope boundary

The CRM turns Oraly from "an AI receptionist" into "an AI that works your leads through a funnel". A customer uploads (or automatically feeds) a CSV of leads into a **funnel**. Oraly calls each lead **in the order of the file**, following rules the customer sets (call immediately during working hours, otherwise queue; retry cadence; stop conditions). Every call produces a transcript; Oraly reads the transcript, **updates the lead's card**, decides whether the lead **moved to the next stage of the funnel, stayed, got stuck, or is lost**, and schedules the next action. Humans see the funnel board, a review queue for uncertain decisions, and tasks for what only a person can do.

In scope (MVP):
- Funnels with stages (templates + customer-defined), leads, lead cards, lists (one per import), tasks, notes, timeline.
- CSV import: manual upload with column mapping and validation; automated intake that stays inside Oraly (§6.3).
- Call rules per list: working-hours gating, call-on-arrival, strict FIFO sequence, retry cadence, max attempts, stop conditions.
- Outbound dialing through the customer's own Oraly number, using an outbound agent built with the existing agent wizard.
- Post-call AI processing: field extraction, summary, stage decision with confidence, stuck detection, next action.
- Inbound calls (existing receptionist agents) also attach to lead cards by phone match and can move the lead in its funnel, so the CRM is the single record of every conversation.
- Funnel reports: stage counts, conversion between stages, velocity, drop-off and stuck analysis, call outcomes.

Out of scope (explicitly):
- Any third-party integration (HubSpot, Salesforce, Google Sheets, Zapier, calendars). Export is CSV only.
- Email or SMS steps in a funnel (Phase 3 in the portal spec; the data model is channel-aware so they can attach later).
- Live calendar booking on the call (Phase 2 of the portal spec).

---

## 2. Framing correction: "inbound funnel", outbound calls, and consent

The leads are **inbound to Oraly**, but every call the CRM places is an **outbound, AI-voice call**. That distinction is not cosmetic:

- The customer portal spec deferred outbound calling to Phase 2 behind a compliance gate. This CRM pulls outbound into **P1**, so the gate (KYC, verified caller ID, consent, calling windows, DNC) ships with it, not after it.
- In the US, AI-generated voice calls are treated as "artificial or prerecorded voice" under TCPA, which requires **prior express written consent** for marketing calls to mobile numbers. Canada's CRTC Unsolicited Telecommunications Rules treat automated dialing-announcing devices similarly and require express consent for solicitation, plus National DNCL compliance. Marketing-campaign leads normally carry that consent (web form opt-in, landing-page checkbox) — the CSV therefore **must carry consent evidence** (§6.2, fields `consent_source`, `consent_timestamp`), and the dialer refuses rows without it.
- Legal execution of the exact consent language, DNC scrubbing provider, and calling-hour rules per jurisdiction is delegated to Michael/counsel; this document builds the product controls so those rules can be enforced without a redeploy (§15).

Vocabulary used from here on: **funnel** (the stages a lead moves through), **intake** (leads arriving), **dial** (an outbound attempt), **reach / touch** (a connected conversation with the lead).

---

## 3. Concepts and vocabulary

| Term | Meaning |
|---|---|
| Funnel | An ordered set of stages with plain-language goals and exit criteria, plus rules for how leads enter, move, get stuck and leave. Every lead is in exactly one funnel at exactly one stage. Full definition in §5. |
| Stage | A step in a funnel (e.g. New → Contacted → Reached → Qualified → Appointment → Won / Lost). Each stage carries a **goal for the agent**, an **exit criterion**, fields to capture, and call behaviour. |
| Lead | A person/company record with at least one phone number, sitting in a funnel. |
| Contact | The person behind a lead; one contact can have several leads over time (one open lead per funnel per contact). |
| List | The batch created by one import (or by one automated feed). A list feeds exactly one funnel and carries its own call rules and agent. Leads keep their list order (`position`). |
| Call rules (playbook) | Per-list configuration: when to call, how many times, how to retry, when to stop, what to do when stuck. |
| Dial attempt | One outbound call placed for a lead. Outcomes: reached, no answer, busy, voicemail, failed, wrong number, declined (DNC/consent/window). |
| Touch | A reached call. Stage movement is judged on touches, not attempts. |
| Stage decision | AI output after a touch: advance / stay / stuck / lost (+ confidence, evidence). Applied automatically above a threshold, otherwise queued for review. |
| Stuck | A lead that has not met its stage's exit criterion after N touches or D days, or that repeats the same blocker. A **flag** on the lead, not a stage. |
| Hand-off | Moving a lead from one funnel to another (e.g. Lost (not now) → Re-engagement funnel after 60 days). |
| Task | Something a human must do (call back personally, send pricing, confirm appointment). Created by stage rules or by the AI's next-action suggestion. |

---

## 4. End-to-end flow

```
 CSV (manual upload │ email-in │ scheduled fetch │ Oraly lead form)
        │
        ▼
 Import wizard: map columns → validate → dedupe → consent check → choose FUNNEL, agent, call rules
        │
        ▼
 Leads created in order (position 1..n) at the funnel's entry stage ──► cards visible on the funnel board
        │
        ▼
 Rules engine on arrival: working hours? consent ok? not DNC? ─ yes ─► enqueue dial now
                                                              └ no ──► enqueue at next calling window
        │
        ▼
 Dialer (strict FIFO per list, concurrency = list setting, credits checked) ─► Retell create-phone-call
        │                                                                      (agent told: current stage + stage goal)
        ├─ not reached ─► retry cadence → re-enqueue, or give up → stage stays, flag "unreachable" after max attempts
        │
        └─ reached ─► transcript + recording ─► Post-call AI:
                        • update card fields (CSV columns + stage capture fields)
                        • summary, sentiment, objections, callback time
                        • stage decision against the funnel's exit criteria: advance / stay / stuck / lost
                        • next action: call again at T / human task / stop / hand off to another funnel
                     ─► apply (auto) or Review queue (low confidence)
        │
        ▼
 Board updates · timeline entry · task created (if any) · next dial scheduled by the rules of the NEW stage
        │
        ▼
 Funnel reports: stage counts, conversion per stage, velocity, drop-off reasons, stuck heatmap, credits per converted lead
```

Inbound calls from a known number follow the same post-call step: the receptionist call's transcript is attached to the matching lead and judged against that lead's funnel.

---

## 5. Funnels

### 5.1 What a funnel is

A funnel is the **unit of business logic** in the CRM. Lists feed it, agents work it, reports measure it. It has:

| Element | Description |
|---|---|
| Identity | name, description, type (template it was created from), owner, status (active/archived), default funnel flag |
| Entry | which lists and intake channels feed it; whether inbound receptionist calls create leads in it; the **entry stage** (normally the first stage, but a list can enter mid-funnel, e.g. "already qualified" leads enter at Qualified); duplicate policy (one open lead per contact per funnel) |
| Stages | 3–12 ordered stages; at least one open stage; exactly one Won-type and one Lost-type terminal stage (both may be renamed). Stage anatomy in §5.4 |
| Movement rules | forward-one-step default, skip-with-evidence, backward (manual / AI regress), time-based moves, hand-off to another funnel, re-entry (§5.5) |
| AI judgement | the rubric (exit criteria), evidence requirements, auto-apply threshold, what goes to review (§5.6) |
| Stuck policy | per-stage thresholds and the stuck playbook (§5.7) |
| Agent | the outbound agent attached (one per funnel), generated with the stage playbook (§8) |
| Targets (optional) | expected conversion per stage and max days per stage — used only for colouring reports and alerts |

A workspace starts with one funnel created from the **Inbound Lead Funnel** template (§5.3). Starter plan: 1 funnel; Growth: 2; Scale: 5; Pro: 10 (admin-configurable).

### 5.2 The two primary funnels

Both use the same stage machinery; they differ in **how leads enter and how calls are triggered**.

| | **Inbound funnel** (speed-to-lead) | **Outbound list funnel** (sequence) |
|---|---|---|
| What it is | Leads arrive one at a time or in small drips from a marketing campaign (web form export, email-in, fetch). The point is to call **within minutes** while the lead is warm. | A bulk CSV (hundreds to thousands of rows) worked **in file order** over days or weeks. The point is coverage and consistency. |
| Entry | automated intake channels + small manual uploads; inbound receptionist calls (optional) | manual upload (large), optionally appended by intake channels |
| Call trigger | **on arrival** if inside the calling window (lead's TZ); otherwise first slot of the next window; arrival order preserved | the dialer walks the list top-to-bottom at the list's concurrency; new rows append to the end |
| Default cadence | retry 15 min → 2 h → next morning (warm lead, tight cadence) | retry 2 h → 1 d → 3 d (cold-ish list, spread cadence) |
| Default agent template | `lead_followup` (identify, confirm the enquiry, qualify, propose next step) | `lead_followup` or `appointment_outbound` |
| Default stages | New → Contacted → Reached → Qualified → Appointment → Won / Lost (Appendix A.1) | same, or the Quote funnel for trades (Appendix A.3) |
| Stuck defaults | 2 touches / 5 days | 2 touches / 10 days |
| Typical owner alerts | every lead reached Qualified+; list paused for credits | daily summary; list finished |

The customer picks the funnel type in the import wizard (§10 C3 step 5); the defaults above are pre-filled and editable.

### 5.3 Funnel template library (MVP)

| ID | Template | Best for | Stages (entry → terminal) | Agent focus | Notes |
|---|---|---|---|---|---|
| `inbound_lead` | Inbound Lead Funnel (default) | any service business running campaigns | New → Contacted → Reached → Qualified → Appointment → Won / Lost | qualify fast, propose next step | A.1 |
| `outbound_list` | Outbound List Funnel | bulk lists, re-activation of old enquiries | New → Contacted → Reached → Interested → Appointment → Won / Lost | identify, gauge interest, book | A.2 |
| `quote` | Quote / Estimate Funnel | home services, trades, renovations | New → Contacted → Site visit booked → Quote sent → Follow-up → Won / Lost | book the visit; after quote, chase decision | A.3 |
| `appointment` | Appointment Funnel | clinics, dental, salons, consultations | Requested → Scheduled → Confirmed → Showed → Rebook / No-show → Won / Lost | confirm, remind, reschedule | A.4; time-based moves |
| `reengagement` | Re-engagement Funnel | leads lost as "not now", dormant customers | Dormant → Re-contacted → Interested → Appointment → Won / Lost | light touch, permission-first | A.5; entered by hand-off |
| `inbound_calls` | Inbound Call Funnel | receptionist callers | Called in → Message taken → Called back → Resolved / Booked → Won / Lost | — (inbound only) | A.6; optional, created from inbound matching |
| `custom` | Custom | anything | blank: New → … → Won / Lost | user-defined | — |

Industry variants (dental, home services, real estate, legal intake, auto, restaurants/events) change stage names, goals, capture fields and example phrasing, not the machinery. Templates are admin-managed (super-admin SA6) and versioned.

### 5.4 Stage anatomy

Every stage has the following fields (edited in C6):

| Field | Type | Req | Used by |
|---|---|---|---|
| Name | text ≤ 30 | ✓ | board column, reports |
| Type | open / won / lost | ✓ | terminal handling |
| Order | int | ✓ | movement rules |
| Description | text ≤ 200 | – | board tooltip |
| **Goal for the agent** | 1–2 sentences ("Confirm the enquiry, understand need and timeline; if qualified, propose a consultation") | ✓ (open stages) | injected into the agent prompt as `{{stage_goal}}` |
| **Exit criterion** | plain language ("Budget range AND timeline stated, decision maker confirmed") | ✓ (open stages) | the AI rubric for *advance* |
| Capture fields | list of {key, type text/number/bool/date/enum, description, required-to-exit?} | – | merged into the agent's post-call analysis schema and the extraction prompt; `required-to-exit` fields must be filled for the AI to advance |
| Agent must not | text ("Don't quote prices", "Don't confirm the slot as booked") | – | appended to the stage block of the prompt |
| Call behaviour | auto-call (cadence from list rules / override) · task for human (template) · stop auto-calls · hand off to funnel X | ✓ | rules engine on entering the stage |
| Cadence override | retry pattern + max attempts for this stage | – | dialer |
| Stuck thresholds | touches / days (override funnel defaults) | – | stuck detector |
| Stuck playbook | what to do when stuck at this stage: retry with alternate opening (agent variable `{{approach}}`) · task · hand off to Re-engagement · mark lost | – | §5.7 |
| Time rule (optional) | "after {field} + X hours, if not {condition} → move to {stage} / create task" (e.g. Appointment → No-show task 2 h after `appointment_time` unless marked Showed) | – | time-based moves |
| SLA (optional) | max days a lead should sit here | – | report colouring, alert |
| Notifications | owner alert on entering this stage (on/off) | – | notifications |

### 5.5 Movement rules

| Rule | Behaviour |
|---|---|
| Forward one step (default) | AI or human moves the lead to the next stage when the exit criterion is evidenced. |
| Skip | AI may skip stages only when the exit criteria of **every** skipped stage are evidenced in the same call (e.g. caller books an appointment on the first touch → New → Appointment). Each skipped stage gets a `stage_history` row with the same evidence so reports stay honest. |
| Stay | Exit criterion not met; stage unchanged; card fields still updated. |
| Regress | AI may propose a backward move only on explicit events (appointment cancelled → Qualified; "we decided to wait" → Reached). Below-threshold regressions always go to review. Humans can drag backward freely. |
| Lost | Requires explicit refusal, a disqualifying fact (wrong market, no budget ever), unreachable after max attempts (`lost_reason = unreachable`), DNC, or a human decision. `lost_reason` is required (enum: not_interested, no_budget, chose_competitor, unreachable, wrong_number, disqualified, dnc, other). |
| Won | Set by the AI only when the lead explicitly confirms the purchase/booking completed; usually set by a human. `value` optional. |
| Time-based | Stage time rules (§5.4) run hourly; they create tasks by default and move stages only when the rule says so. |
| Hand-off to another funnel | On a terminal stage, a hand-off rule (e.g. Lost (not_interested/not_now) → Re-engagement after 60 days; Won → Appointment funnel for the booked visit) creates a **new lead** for the same contact in the target funnel, linked both ways. Consent carries over; DNC never does (a DNC contact can't be handed off). |
| Re-entry | A contact with a closed lead who appears in a new import enters as a new lead (policy chosen in the import wizard) with a "Previously: Lost (no_budget), Mar 2026" chip on the card and previous summaries in the agent context. |
| Manual override | Drag on the board or "Advance / Mark lost" on the card; logged as `manual`; pauses AI movement for that lead until the next touch. |
| One open lead per contact per funnel | Enforced; duplicates merge into the open lead. |

### 5.6 How the AI judges movement

1. The extraction prompt (Appendix C) receives the **funnel definition** (stage order, goals, exit criteria, capture fields with required-to-exit flags), the **lead card** (fields with origins, previous summaries, stage history), the **call transcript**, and the list rules.
2. It returns a `stage_decision` with `decision`, `to_stage`, `confidence`, `evidence` (verbatim snippets) and `reason`, plus `field_updates` with per-field confidence.
3. Guard rails applied by code, not by the model: advance requires all required-to-exit fields present; skip rule (§5.5); lost requires a `lost_reason`; regress only on the listed events; DNC request overrides everything.
4. Apply if `confidence ≥ funnel.auto_apply_threshold` (default 0.80); otherwise create a review item with the suggestion preselected. Field updates below threshold are still applied (they're reversible and low-risk) but marked "unconfirmed" on the card.
5. Every decision is written to `stage_history` with evidence; the card shows "Moved to Qualified by Oraly — 'we have about 25 to 30 thousand set aside' — Undo".
6. Accepted and overridden reviews are stored and surfaced in C10 ("AI accuracy") and used in P2 to tune the per-workspace rubric wording.

### 5.7 Stuck: definition and playbook

A lead is flagged **stuck** when any of these hold at an open stage:
- touches at this stage ≥ `stuck_touches` (funnel default 2) without meeting the exit criterion;
- days at this stage ≥ `stuck_days` (funnel default 7; stage override);
- the same objection/blocker appears in two consecutive touches (price, "waiting on partner", "call me later" without a date);
- a required-to-exit field remains unknown after two touches.

The **stuck playbook** (per stage, with a funnel default) runs once when the flag is raised:

| Action | What happens |
|---|---|
| Retry with a different approach | next dial passes `{{approach}}` = the stage's alternate opening (e.g. "offer a shorter consultation", "mention financing"); max 1 extra attempt |
| Create task for a human | task template ("Personal call: {{lead_name}} stuck at {{stage}} — {{blocker}}") assigned to the lead owner |
| Hand off | move to Re-engagement funnel after N days |
| Mark lost | with `lost_reason` from the detected blocker |
| Do nothing (flag only) | shows ⚠ on the board and in reports |

Stuck leads appear on the board with a ⚠ and days count, in a saved filter, on Home ("9 stuck leads"), in the daily digest, and in the C10 stuck heatmap (stage × blocker).

### 5.8 Funnel ↔ lists ↔ agent

- A **list feeds one funnel**; a funnel can be fed by many lists and channels. The list chooses the entry stage (default: first).
- A **funnel has one outbound agent**; the agent's prompt contains a "Stage playbook" generated from the stage goals/exit criteria/must-nots (§8). Changing a stage marks the agent "Republish needed". Lists may override the agent (A/B in P2).
- Inbound receptionist agents are not attached to a funnel; their calls are matched to leads by phone and judged against whichever funnel the lead is in (or create a lead in the default funnel / Inbound Call funnel).
- Credits are reported per funnel and per list.

### 5.9 Funnel metrics (definitions used in C10 and Home)

| Metric | Definition |
|---|---|
| Stage count | open leads currently at the stage |
| Stage conversion | leads that ever advanced from stage i to i+1 ÷ leads that ever entered stage i (cohort by entry date) |
| Funnel conversion | leads reaching Won ÷ leads entered |
| Velocity | median days from entry to each stage; median days in stage |
| Reach rate | reached dials ÷ dials; attempts-to-reach distribution |
| Drop-off | Lost by stage and `lost_reason` |
| Stuck rate | stuck leads ÷ open leads, by stage and blocker |
| Cost | credits per reached lead, per Qualified lead, per Won lead; per list |
| AI accuracy | auto-applied decisions ÷ all; review acceptance rate; override matrix (suggested vs chosen) |
| Speed-to-lead (inbound funnel) | median minutes from arrival to first dial and to first reach |

### 5.10 Funnel limits and gates

| Plan | Funnels | Stages per funnel | Capture fields per funnel | Hand-off rules | Time rules |
|---|---|---|---|---|---|
| Starter | 1 | ≤ 8 | ≤ 10 | – | – |
| Growth | 2 | ≤ 10 | ≤ 15 | ✓ | ✓ |
| Scale | 5 | ≤ 12 | ≤ 25 | ✓ | ✓ |
| Pro | 10 | ≤ 12 | ≤ 30 | ✓ | ✓ |

All admin-configurable (super-admin SA5).

---

## 6. Lead intake — CSV import

### 6.1 Manual import (primary path)
Wizard C3 (§10). Accepts `.csv` (UTF-8, comma/semicolon/tab auto-detected), `.xlsx` (first sheet). Max 10,000 rows per file (Starter 500, Growth 2,000, Scale 10,000 — configurable in admin). Rows are imported **in file order**; `position` = row number.

### 6.2 Required and recognised columns

| Column (any header; mapped in wizard) | Req | Validation | Notes |
|---|---|---|---|
| Phone | ✓ | E.164 after normalisation using workspace country as default region; mobile/landline type detected (libphonenumber); invalid → row error | Primary matching key for dedupe and inbound matching |
| First name / Last name / Full name | – | ≤ 80 chars | used in greeting (`{{lead_first_name}}`) |
| Email | – | RFC format | secondary dedupe key |
| Company | – | ≤ 120 chars | |
| Source / campaign | – | free text | defaults to list name |
| Consent source | ✓ (when the list's rules place calls) | enum: `web_form`, `phone_optin`, `written`, `existing_customer`, `other` | stored as consent evidence; `none`/blank → lead imported but **never dialed** (flag "No consent") |
| Consent timestamp | – (recommended) | ISO date | shown on card |
| Lead time zone | – | IANA or US/CA state/province → TZ | default workspace TZ; used for calling windows |
| Preferred language | – | locale | passed to agent (`{{lead_language}}`) |
| Interest / product / notes | – | ≤ 2,000 chars | injected into agent context as "what we know" |
| Stage (optional) | – | must match a stage name in the chosen funnel | allows entering mid-funnel; default = funnel entry stage |
| Owner (optional) | – | member email | default list owner |
| Any other column | – | stored as custom field (key = header, ≤ 30 custom fields per workspace) | visible on card, available as `{{custom.<key>}}` |

### 6.3 Automated intake (inside Oraly only)
Each list can be given one or more **intake channels**. All produce rows that go through the same mapping/validation as a manual upload (mapping is saved per channel, so no human step is needed after setup):

| Channel | How it works | Needs |
|---|---|---|
| **Email-in** | Workspace gets `leads+<token>@in.oraly…`; any CSV/XLSX attachment sent there is imported with the saved mapping. Sender must be a workspace member or an allow-listed address. | transactional inbound-mail parsing (already used for support tickets) |
| **Scheduled fetch** | Customer gives a CSV URL they host (e.g. an export their campaign tool publishes); Oraly fetches it every N minutes/hours, imports only new rows (dedupe by phone+email+row hash). | outbound HTTPS fetch; URL stored encrypted; "Fetch now" test |
| **Upload link / drop endpoint** | A signed `POST /intake/<token>` accepting multipart CSV; the customer's campaign tool or a colleague can push files without logging in. Rate-limited, token rotatable. | nothing external — generic endpoint, not an integration |
| **Oraly lead form** (Phase 2) | A hosted form (`forms.oraly…/<slug>`) with consent checkbox; each submission is one lead straight into the inbound funnel. Embeddable snippet. | hosted page |

Every automated import creates an `import_jobs` row and appears in C4 with its outcome; failures email the list owner.

### 6.4 Dedupe and merge rules
- Match on normalised phone (primary) then email. Default action: **skip duplicate and attach the new row's data to the existing lead as a note** ("Re-imported on … from list X"); options: update empty fields / overwrite / create new lead if the existing one is Won or Lost (re-entry, §5.5). Chosen in the wizard, saved per channel.
- DNC: a phone marked do-not-call anywhere in the workspace (or on the admin global blocklist) imports with flag `dnc` and is never dialed.

---

## 7. Call rules and calling sequence

Rules live on the **list** (defaults copied from the funnel type's playbook; stage-specific overrides come from the funnel's stages, §5.4).

### 7.1 Rule fields

| Group | Field | Type / options | Default (inbound funnel / outbound list) |
|---|---|---|---|
| When to call | Call on arrival | on/off | on / on |
| | Calling window | weekly schedule (per weekday, start–end) + "use lead's time zone" / "use my time zone" | Mon–Fri 09:00–18:00, lead's TZ |
| | Outside window | queue for next window / don't call / call anyway (blocked unless admin allows) | queue |
| | Earliest/latest legal hours | fixed per country (admin-configurable; hard floor) | — |
| Sequence | Order | strict file order (FIFO) / priority then FIFO | FIFO |
| | Outbound concurrency for this list | 1 … (plan cap − inbound reserve) | 1 (guarantees order) |
| | Inbound reserve | concurrent slots kept free for inbound calls | 1 |
| Retries | No answer | retry after X, max N | 15 min → 2 h → next morning / 2 h → 1 d → 3 d |
| | Busy | retry after 30 min, max 3 | |
| | Voicemail | leave message (yes/no; script generated from brief) / hang up; cadence as no-answer | no message (P1) |
| | Failed / invalid number | mark "Bad number", create task | |
| | Wrong person / number | mark "Wrong number", stop | |
| | Max dial attempts per lead | 1–10 | 4 |
| Stage behaviour | comes from the funnel's stage call behaviour (§5.4); the list can only tighten (e.g. "never auto-call at Qualified for this list") | | |
| | Callback requested | schedule dial at the requested time ± window | on |
| Stop conditions | Lead says "stop calling" / "not interested" ×2 / terminal stage / DNC / consent withdrawn | always on (guardrail) | |
| Budget | Credits cap for this list | number or none | none |
| | Daily dial cap for this list | number | plan default |
| Notifications | Owner alerts: lead reached Qualified+, lead stuck, list finished, list paused (credits/cap) | email/in-app | on |

### 7.2 Sequence semantics
- A list is a FIFO queue keyed by `position`. With concurrency 1, lead 2 is never dialed before lead 1's attempt finishes. Retries are **re-inserted at the head of the queue at their due time**, so file order is preserved for first attempts while due retries interleave.
- Pausing a list freezes the queue; resuming continues from where it stopped. Leads can be moved up ("Call next") or skipped manually.
- New rows arriving via automated intake are appended to the end (outbound list) or dialed on arrival (inbound funnel, which effectively keeps the queue short).
- Across lists, each list runs its own queue; the tenant's outbound concurrency (plan cap − inbound reserve) is shared round-robin between active lists.

### 7.3 What "call immediately during working hours" means operationally
Lead row committed → rules evaluated within 5 s → if window open (lead TZ), consent ok, not DNC, credits > 0, attempts = 0 → `call_queue` row `due_at = now` → dialer picks it up on its next tick (≤ 10 s) subject to concurrency.

---

## 8. The outbound agent (stage-aware)

- Built with the existing agent wizard (portal spec W1–W5) using a new template **`lead_followup`** ("Lead follow-up / qualification call") and, for appointment funnels, **`appointment_outbound`**. Same voice/language/test/publish flow; test calls can use a sample lead at any stage.
- **One agent per funnel.** The generated prompt contains a "Stage playbook" section built from the funnel's stages: for each open stage, the goal, the exit criterion rephrased as "what to find out", the capture fields, and the must-nots. At call time the agent receives `{{current_stage}}`, `{{stage_goal}}`, `{{stage_must_not}}`, `{{fields_still_needed}}` and `{{approach}}` (normal / alternate when stuck).
- Dynamic variables per dial: `{{lead_first_name}}`, `{{lead_company}}`, `{{lead_source}}`, `{{lead_interest}}`, `{{lead_language}}`, `{{previous_call_summary}}`, `{{attempt_number}}`, `{{custom.*}}`, plus the workspace variables already defined (`{{business_name}}`, `{{agent_name}}`, `{{current_time}}`).
- Opening line is generated and includes identification and purpose ("Hi {{lead_first_name}}, this is {{agent_name}} calling from {{business_name}} about the request you made on our website…"). Guardrails add: if the person says they are not interested or asks not to be called → apologise, confirm removal, end; the post-call step marks `dnc` immediately.
- Post-call analysis schema for the template (Retell `post_call_analysis_data`): `reached_lead` (bool), `right_person` (bool), `outcome` (enum: interested / not_now / not_interested / callback / wrong_number / no_decision), `callback_at` (text), `objections` (text), `interest_level` (1–5), `appointment_requested` (bool), `appointment_time` (text), plus the funnel's capture fields. Our own extraction pass (§9) runs on top of this.

---

## 9. Post-call processing: card update, stage movement, stuck detection

### 9.1 Trigger
Retell `call_analyzed` (or `call_ended` with transcript if analysis is late > 60 s) for any call with `metadata.lead_id` **or** any inbound call whose `from_number` matches a lead.

### 9.2 Processing steps
1. **Classify attempt outcome** from `disconnection_reason` + `reached_lead`: reached / no_answer / busy / voicemail / failed / wrong_number. Not-reached outcomes skip to step 6; no stage decision is made from an unanswered dial.
2. **Extract** (Anthropic API, structured JSON, Appendix C): field updates (funnel capture fields + custom fields explicitly mentioned), summary (≤ 60 words), sentiment, objections, commitments made by either side, callback time, next-best action.
3. **Stage decision** against the funnel definition (§5.6 rules): `{decision: advance|stay|stuck|lost|regress, to_stage?, confidence, evidence[], reason, lost_reason?}`.
4. **Apply**: confidence ≥ funnel threshold → write field updates, move stage (including skipped-stage history rows), record `stage_history`; below threshold → write field updates as "unconfirmed" and put the stage decision into the Review queue (C8) with the AI's suggestion preselected. Overrides are stored (`review_items.override_to_stage_id`).
5. **Timeline entry** on the card: call, duration, credits, outcome, summary, decision, evidence; recording and transcript links.
6. **Next action** from the **new stage's call behaviour** (§5.4) and the list cadence: schedule next dial (`due_at`), create a task, stop, or hand off. Callback requests override the cadence.
7. **Stuck detection** — call-based rules inline (step 3); time-based rule by the hourly job; raising the flag runs the stage's stuck playbook (§5.7).
8. **Notifications**: owner alert on entering stages with alerts on (default Qualified+), on stuck, on lost with reason; daily digest lists reached leads, stage moves per funnel, review-queue count, tasks due.

### 9.3 Guarantees
- A stage never moves on an unanswered dial. A card field is never overwritten with lower-confidence data than it already has (field-level confidence stored). Every automatic change shows "Updated by Oraly from call on … — Undo".
- Humans can always drag a card to any stage; manual moves are logged as `manual` and pause auto-movement for that lead until the next touch.

---

## 10. Screens

All screens live under `/app/leads` in the portal shell; the left nav gains **Leads** (between Calls and Agents). Roles follow the portal matrix: Editor+ can import, edit, run rules; Viewer read-only; Owner/Admin manage funnels and limits.

### C1 — Funnel board & table
Route `/app/leads` · tabs **Board** (kanban by stage of the selected funnel) · **Table**.

```
┌ Leads ─ Funnel: [Inbound Lead Funnel ▾]  List: [All ▾]  Owner: [Any ▾]  🔍  [Import CSV] [+ Lead] [⋯] ┐
│ ● Calling now: 1 · Queued: 212 · Review: 4 · Stuck: 9 · Credits today: 38 · Conv. 30d: 11% ▸ Reports │
│ New (212) │ Contacted (41) │ Reached (18) │ Qualified (7) │ Appointment (3) │ Won (2) │ Lost (14)    │
│ ▁▁▁▁▁▁▁▁  │ ▁▁▁▁           │ ▁▁             │ ▁              │ ▁               │          │            │  ← stage conversion bars
│ ┌────────┐ │ ┌────────┐     │ ┌────────┐     │ ┌────────┐     │                 │          │            │
│ │Maria L.│ │ │Tom R.  │     │ │Aisha K.│⚠   │ │Dan P.  │✓   │                 │          │            │
│ │+1 514… │ │ │2 tries │     │ │stuck 8d│     │ │task due│     │                 │          │            │
│ │Web form│ │ │next 2h │     │ │…       │     │          │     │                 │          │            │
│ └────────┘ │ └────────┘     │ └────────┘     │ └────────┘     │                 │          │            │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Card chips: next dial time / attempts, stuck (⚠ + days), needs review (🟡), task due (✓), DNC/no-consent (🚫), inbound-origin (☎), re-entry ("Prev: Lost"). Column header shows count, median days in stage and stage conversion (30 d). Drag between columns = manual stage change (confirm modal with optional note; backward moves ask for a reason). Funnel selector switches boards; "Edit funnel" link → C6.

Table columns: name, phone (masked for Viewer), company, funnel, stage, list, position, attempts, last outcome, last call, next action (dial at / task / stop), interest, owner, consent, created. Filters: funnel, stage, list, outcome, stuck, needs review, consent, owner, date ranges, free text. Bulk actions: move stage, assign owner, mark DNC, pause/resume dialing, hand off to funnel, add tag, export CSV, delete (Owner/Admin).

| Action | Frontend | Backend |
|---|---|---|
| Import CSV | → C3 | — |
| + Lead | drawer with the §6.2 fields + funnel/stage; consent required to enable dialing | `POST /leads` → rules engine on arrival |
| Drag card | optimistic move, confirm | `PATCH /leads/:id/stage {to, note}` (source=manual) |
| Pause/resume dialing (lead) | toggle on card menu | `PATCH /leads/:id {dial_paused}` |
| Call next | card menu | `POST /leads/:id/call-now` → head of queue |
| Hand off | card menu → pick funnel + entry stage | `POST /leads/:id/handoff {funnel_id, stage_id}` |

### C2 — Lead detail
Route `/app/leads/[id]` (drawer on desktop, page on mobile).

```
┌ Maria Lopez · Inbound Lead Funnel · Qualified · List "Oct webinar" #37 · Owner: Sam ── [Call now] [Task] [⋯] ┐
│ ┌ Contact ───────────────┐ ┌ Funnel ───────────────────────┐ ┌ Next ───────────────────────┐ │
│ │ +1 514 555 0199 (mobile)│ │ New → Contacted → Reached →   │ │ Task: Send pricing (due Fri)│ │
│ │ maria@…  · Montréal, QC │ │ ●Qualified → Appointment      │ │ Dial: task stage (no auto)  │ │
│ │ Source: Web form (Oct 3)│ │ 2 touches · 6 days in stage   │ │ Interest ●●●●○              │ │
│ │ Consent: web_form ✓     │ │ Exit: next step agreed with   │ │ [Advance] [Mark lost]       │ │
│ │ Lang: fr-CA · TZ ET     │ │ date/time ✗ (needs: time)     │ │ [Hand off ▾]                │ │
│ └─────────────────────────┘ └───────────────────────────────┘ └─────────────────────────────┘ │
│ ┌ Card fields (CSV + extracted) ──────────────────────────────────────────────────────────────┐ │
│ │ Need: kitchen renovation · Budget: 25–30k (call 2, 0.92) · Timeline: Jan (0.88)            │ │
│ │ Objection: comparing 2 quotes · Custom: Lead score 78 · Edit ✎                             │ │
│ └─────────────────────────────────────────────────────────────────────────────────────────────┘ │
│ ┌ Timeline ───────────────────────────────────────────────────────────────────────────────────┐ │
│ │ Oct 9 14:02  📞 Outbound · reached · 4:12 · 4.2 cr · Summary… · Decision: advance →         │ │
│ │              Qualified (0.91) "we have about 25 to 30 thousand set aside" ▸ transcript ▸ ▶  │ │
│ │ Oct 7 10:30  📞 Outbound · no answer (attempt 1)                                            │ │
│ │ Oct 7 10:29  ⚙ Rules: arrived during window → dial now                                     │ │
│ │ Oct 7 10:29  ⬆ Imported from "Oct webinar" (row 37) into Inbound Lead Funnel at New        │ │
│ │ 📝 Add note…                                                                               │ │
│ └─────────────────────────────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

The **Funnel** panel shows the stage path, the current stage's exit criterion with a ✓/✗ per required-to-exit field, touches and days in stage, stuck status and the playbook action taken. Actions: Call now (ignores cadence, respects legal hours/consent), Create task, Edit fields (each shows origin CSV / call n / manual, with confidence), Advance / Mark lost (manual decision with note; lost needs a reason), Hand off, Pause dialing, Mark DNC, Change owner, Add tag, Merge with… (duplicate), Delete. Transcript viewer and recording player reuse portal D2 components.

### C3 — Import wizard
Route `/app/leads/import` · 6 steps, each resumable.

| Step | Screen | Fields / actions | Backend |
|---|---|---|---|
| 1 Upload | dropzone + "Download CSV template" (Appendix B) | file ≤ 20 MB; row count shown; plan row cap check | `POST /imports {file}` → parse headers + first 50 rows (sync) |
| 2 Map columns | two-column mapper: file header → Oraly field (auto-matched by header synonyms; unmapped → custom field or ignore); sample values shown | Phone mapping required; "Save mapping for this list/channel" | `PUT /imports/:id/mapping` |
| 3 Validate | summary: valid / fixable (phone normalised) / errors (invalid phone, missing consent, duplicates) with downloadable error CSV; per-row fix inline for ≤ 50 errors | choose: skip errors / stop | `POST /imports/:id/validate` (job) |
| 4 Duplicates | count + rule: skip / update empty / overwrite / new lead if closed (re-entry) | | `PUT /imports/:id/dedupe` |
| 5 Funnel & rules | **Funnel** (existing, or "New from template" → mini-picker of §5.3), **entry stage** (default first), **outbound agent** (the funnel's agent; link to create/publish one), owner, call rules pre-filled from the funnel type (§7.1; edit inline), credits cap, consent attestation checkbox ("I confirm these leads consented to be contacted by phone, including automated calls") | required: funnel + agent + attestation to enable dialing; otherwise import without dialing | `PUT /imports/:id/rules` |
| 6 Preview & start | estimated dials, estimated credits (range), first 10 leads in order, window check ("Calling starts now / Mon 09:00 ET"), funnel preview (stages the leads will move through) | **Start import** / **Import without calling** | `POST /imports/:id/commit` → leads created in order → rules engine |

Progress page shows rows imported, queued, first dial time; errors list.

### C4 — Lists & intake channels
Route `/app/leads/lists`. Table: list name, source (manual/email-in/fetch/endpoint/form), funnel, entry stage, agent, leads, progress (dialed/reached/advanced), status (Running / Paused / Finished / Waiting for window / Paused: no credits / Paused: cap), credits used, created, owner. Actions: Pause/Resume, Edit rules, Add intake channel (modal per §6.3 with saved mapping), Archive. Detail = list-scoped board + run log (each rules decision and dial).

### C5 — Call rules (playbooks)
Route `/app/leads/rules`. Workspace default playbooks per funnel type (inbound / outbound list) using the §7.1 form, plus per-list overrides list. "Simulate" panel: pick a sample lead and time → shows what the rules would do ("Outside window → queued for Tue 09:00 ET"). Legal-hour floor and country rules shown read-only (from admin).

### C6 — Funnels (builder)
Route `/app/leads/funnels` (list) · `/app/leads/funnels/[id]` (builder).

```
┌ Funnels ──────────────────────────────────────────────── [+ New funnel ▾ from template] ┐
│ Inbound Lead Funnel (default) · 6 stages · 2 lists · agent Sophie v4 · 11% conv · Edit  │
│ Quote Funnel · 6 stages · 1 list · agent Marc v2 · 18% conv · Edit                      │
└─────────────────────────────────────────────────────────────────────────────────────────┘

┌ Inbound Lead Funnel ─── [Preview agent playbook] [Test with a transcript] [Save] [Publish agent ⚠] ┐
│ Entry: lists Oct webinar, Site form · ☑ create leads from inbound calls · entry stage: New        │
│ Auto-apply threshold ─●──── 0.80   Stuck defaults: 2 touches / 7 days   Hand-offs: Lost→Re-engage 60d │
│ ┌ New ┐→┌ Contacted ┐→┌ Reached ┐→┌ Qualified ┐→┌ Appointment ┐→┌ Won ┐ ┌ Lost ┐   [+ stage]      │
│ └─────┘ └───────────┘ └─────────┘ └───────────┘ └─────────────┘ └─────┘ └──────┘   (drag to reorder) │
│ ┌ Stage: Reached ───────────────────────────────────────────────────────────────────────────────┐ │
│ │ Goal for the agent   [Understand need, timeline and budget range; confirm who decides      ] │ │
│ │ Exit criterion       [Budget range AND timeline stated; decision maker confirmed            ] │ │
│ │ Capture fields       budget (text, required to exit) · timeline (text, req) · decision_maker │ │
│ │                      (bool, req) · objections (text)   [+ field]                             │ │
│ │ Agent must not       [Quote final prices; promise a date]                                    │ │
│ │ Call behaviour       ● Auto-call again (cadence: list default)  ○ Task  ○ Stop  ○ Hand off   │ │
│ │ Stuck                after [2] touches or [7] days → ● Retry with alternate opening          │ │
│ │                      [Offer a 15-minute consultation instead of a quote]  ○ Task ○ Hand off  │ │
│ │ Time rule            (none)                       SLA [5] days    Alert owner on entry ☐     │ │
│ └───────────────────────────────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Element | Behaviour | Backend |
|---|---|---|
| New funnel from template | picks a §5.3 template → stages prefilled; industry variant select | `POST /funnels {template_id, industry}` |
| Stage strip | add (max per plan), rename, reorder by drag, delete (only if empty; else "move leads to…"), set type (one won, one lost) | `POST/PATCH/DELETE /funnels/:id/stages`, `PUT …/stages/order` |
| Stage editor | all §5.4 fields with inline validation (open stages need goal + exit criterion) | `PATCH /funnels/:id/stages/:sid` |
| Funnel settings | entry lists (read-only list), inbound-call creation toggle, entry stage, auto-apply threshold, stuck defaults, hand-off rules (from terminal stage → funnel, after N days, filter by lost_reason), duplicate policy | `PATCH /funnels/:id` |
| Preview agent playbook | read-only drawer showing the generated "Stage playbook" block as the agent will receive it | `GET /funnels/:id/playbook` |
| Test with a transcript | paste a transcript (or pick a past call) + choose current stage → shows the stage decision, evidence and field updates the AI would produce, without touching any lead | `POST /funnels/:id/test-decision` |
| Publish agent ⚠ | appears when stages changed since the agent was last generated → regenerates the stage-playbook section and opens the agent's Test & publish tab | `POST /agents/:id/generate {mode: stage_playbook}` |
| Archive funnel | only when no open leads (else move them first) | `POST /funnels/:id/archive` |

### C7 — Dialer status (live)
Route `/app/leads/dialer`. Live cards: calling now (lead, funnel/stage, list, agent, timer), queued per list with next due times, today's dials/reached/credits, blocked reasons (window closed, no credits, cap reached, inbound reserve). Buttons: Pause all outbound, Resume, Set concurrency (within plan). Real-time via SSE topic `dialer`.

### C8 — Review queue
Route `/app/leads/review`. Items: lead, funnel/stage, call (summary + evidence snippets + play), AI suggestion ("Advance to Qualified, 0.62") with reason and the exit criterion it was judged against. Actions: Accept, Change to… (any stage), Keep in stage, Mark stuck, Mark lost (reason), Open transcript. Keyboard shortcuts; bulk accept ≥ 0.70. Threshold slider per funnel (Owner/Admin).

### C9 — Tasks
Route `/app/leads/tasks`. My tasks / all; task: title, lead (funnel/stage), due, origin (stage rule / stuck playbook / AI / manual), done. Appears on portal Home (D1) as "Tasks due today" and in the daily digest.

### C10 — Funnel reports
Route `/app/leads/reports`. Filters: funnel (required), list, owner, range, cohort (by import week / arrival week).

| Block | Content |
|---|---|
| Funnel chart | leads per stage (ever entered) with conversion % between each pair; Won / Lost totals |
| Velocity | median days to reach each stage; median days in stage; SLA breaches |
| Speed-to-lead (inbound funnels) | median minutes arrival → first dial, arrival → first reach; by hour of day |
| Reach | reach rate, attempts-to-reach histogram, outcomes per dial (no answer / busy / voicemail / wrong number) |
| Drop-off | Lost by stage × `lost_reason` |
| Stuck heatmap | stage × blocker (objection) with counts and median days; click → filtered board |
| Cost | credits per reached / Qualified / Won lead; per list; vs pack |
| AI accuracy | auto-applied %, review acceptance %, override matrix (suggested → chosen) |
| List comparison | the same metrics side by side for lists feeding this funnel |

Export CSV per block.

---

## 11. Credits, limits and plan gates

| Item | Rule | Where set |
|---|---|---|
| Outbound connected minutes | same tier rate as inbound (Standard 1 cr/min, Premium 1.5) | admin SA5 Rates |
| Unanswered / busy / failed dials | 0 credits (Retell bills connected calls only — verify no carrier per-attempt charge in P0) | — |
| Optional per-dial attempt fee | default 0; admin can set (anti-spam lever) | SA5 Rates |
| Verified caller ID (reduces "Spam likely" labelling) | Retell $10 one-time → 15 credits one-time per number, required for outbound (admin default on) | SA5 |
| Leads stored | Starter 500 · Growth 2,000 · Scale 10,000 · Pro 50,000 | SA5 Packs |
| Daily dial cap per workspace | Starter 100 · Growth 500 · Scale 2,000 · Pro 10,000 | SA5 Packs |
| Outbound concurrency | plan concurrency cap − inbound reserve (min 1) | SA5 Packs + list setting |
| Funnels / stages / fields / hand-offs / time rules | per §5.10 | SA5 Packs |
| Intake channels | Starter: manual only · Growth+: email-in, fetch, endpoint · Scale+: lead form | SA5 Packs feature gates |
| Outbound enablement | business verification (KYC) approved in admin SA11 + verified caller ID + consent attestation per list | SA11 |
| Zero balance | dialer pauses all lists ("Paused: no credits"); inbound unaffected until its own grace | §14 portal |

Cost sanity check (Standard, reach rate 35 %, avg reached call 3 min): 1,000 leads × 4 attempts max ≈ 2,100 dials → ≈ 350 reached × 3 min ≈ 1,050 credits ≈ a Scale pack; our COGS ≈ $115 → ~65 % margin, consistent with the portal model.

---

## 12. Data model (additions to portal spec §15)

| Table | Key fields |
|---|---|
| `funnels` | id, tenant_id, name, description, template_id, industry, is_default, status (active/archived), entry_stage_id, create_from_inbound (bool), auto_apply_threshold, stuck_touches, stuck_days, handoff_rules_json [{from_stage_id, lost_reasons[], after_days, to_funnel_id, to_stage_id}], duplicate_policy, targets_json, agent_id, playbook_version, created_at |
| `stages` | id, funnel_id, name, type (open/won/lost), order, description, agent_goal, exit_criterion, capture_fields_json [{key,type,description,required_to_exit,enum[]}], must_not, call_behaviour (auto_call/task/stop/handoff), task_template, cadence_override_json, stuck_touches, stuck_days, stuck_playbook_json {action, alternate_approach, task_template, handoff_funnel_id, after_days}, time_rule_json, sla_days, alert_on_entry |
| `contacts` | id, tenant_id, phone_e164, phone_type, email, first_name, last_name, company, timezone, language, dnc (bool), dnc_reason, dnc_at; unique(tenant_id, phone_e164) |
| `leads` | id, tenant_id, contact_id, funnel_id, stage_id, list_id, position, owner_user_id, source, consent_source, consent_at, interest_level, status (open/won/lost/unreachable/bad_number), lost_reason, stuck (bool), stuck_since, stuck_action_taken, needs_review (bool), dial_paused (bool), attempts, touches, touches_in_stage, entered_stage_at, last_outcome, last_call_at, next_action_type (dial/task/none/handoff), next_action_at, fields_json ({key:{value, origin, confidence, confirmed, updated_at}}), tags[], previous_lead_id, created_at; unique open lead per (contact_id, funnel_id) |
| `lead_lists` | id, tenant_id, name, funnel_id, entry_stage_id, funnel_type (inbound/outbound), agent_id (nullable override), owner_user_id, rules_json, credits_cap, credits_used, status, row_count, dialed_count, reached_count, advanced_count, source_type, created_at |
| `intake_channels` | id, list_id, type (email/fetch/endpoint/form), config_json (encrypted where needed), mapping_json, dedupe_mode, token_hash, last_run_at, last_result_json, active |
| `import_jobs` | id, tenant_id, list_id, channel_id (nullable), file_name, status (parsing/mapping/validated/committing/done/failed), row_count, valid_count, error_count, duplicate_count, mapping_json, errors_file_url, started_by, created_at |
| `import_rows` | id, import_job_id, row_no, raw_json, normalised_json, status (ok/fixed/error/duplicate), error, lead_id |
| `call_queue` | id, tenant_id, list_id, lead_id, due_at, priority, attempt_no, reason (arrival/retry/callback/manual/stuck_retry), approach (normal/alternate), state (queued/dialing/done/cancelled), blocked_reason, created_at; index (tenant_id, list_id, state, due_at, position) |
| `dial_attempts` | id, lead_id, list_id, call_id (retell), attempt_no, placed_at, outcome (reached/no_answer/busy/voicemail/failed/wrong_number/declined), disconnection_reason, duration_s, credits, next_retry_at |
| `stage_history` | id, lead_id, funnel_id, from_stage_id, to_stage_id, decision (advance/skip/stay/stuck/lost/regress/manual/handoff/time_rule), confidence, evidence_json, reason, lost_reason, call_id, actor (ai/user_id/system), created_at |
| `review_items` | id, lead_id, call_id, suggestion_json, exit_criterion_snapshot, status (open/accepted/overridden), resolved_by, resolved_at, override_to_stage_id |
| `lead_activities` | id, lead_id, type (import/rule/dial/call/stage/field_update/note/task/dnc/handoff/stuck), payload_json, actor, created_at |
| `tasks` | id, tenant_id, lead_id, title, due_at, assignee_user_id, origin (stage_rule/stuck/ai/manual/time_rule), status, created_at |
| `playbooks` | id, tenant_id, funnel_type (inbound/outbound), is_default, rules_json |
| `consent_records` | id, contact_id, source, captured_at, evidence_text, import_job_id, attested_by_user_id |
| `dnc_entries` | id, tenant_id (nullable = global), phone_e164, reason, source (lead_request/manual/admin), created_at |
| `funnel_templates` (admin-managed) | id, name, industry_variants_json, stages_json, default_rules_json, version, active |

Portal-side additions: `calls.lead_id`, `calls.dial_attempt_id`, `calls.direction` (outbound used now), `tenants.outbound_enabled`, `tenants.kyc_status`, `phone_numbers.verified_caller_id`, `agents.funnel_id` (for `lead_followup` / `appointment_outbound` agents), `agent_versions.playbook_version`.

---

## 13. API surface (portal JWT, `X-Workspace-Id`)

| Area | Endpoints |
|---|---|
| Funnels | `GET/POST /funnels` · `GET /funnels/:id` · `PATCH /funnels/:id` · `POST /funnels/:id/archive` · `POST /funnels/:id/stages` · `PATCH/DELETE /funnels/:id/stages/:sid` · `PUT /funnels/:id/stages/order` · `GET /funnels/:id/playbook` · `POST /funnels/:id/test-decision {transcript|call_id, stage_id}` · `GET /funnels/templates` |
| Leads | `GET /leads` (filters, board grouping by funnel) · `POST /leads` · `GET /leads/:id` · `PATCH /leads/:id` · `PATCH /leads/:id/stage` · `POST /leads/:id/handoff` · `POST /leads/:id/call-now` · `POST /leads/:id/dnc` · `POST /leads/:id/merge` · `POST /leads/bulk` · `POST /leads/export` · `DELETE /leads/:id` |
| Imports | `POST /imports` · `GET /imports/:id` · `PUT /imports/:id/mapping` · `POST /imports/:id/validate` · `PUT /imports/:id/dedupe` · `PUT /imports/:id/rules` (funnel_id, entry_stage_id, agent_id, rules) · `POST /imports/:id/commit` · `GET /imports/:id/errors.csv` · `GET /imports/template.csv` |
| Lists & intake | `GET/POST /lists` · `GET /lists/:id` · `PATCH /lists/:id` · `POST /lists/:id/(pause|resume|archive)` · `POST /lists/:id/channels` · `PATCH/DELETE /lists/:id/channels/:cid` · `POST /lists/:id/channels/:cid/run-now` · public: `POST /intake/:token` (multipart) |
| Playbooks | `GET/PUT /playbooks/:funnel_type` · `POST /playbooks/simulate {lead_id, at}` |
| Dialer | `GET /dialer/status` · `POST /dialer/(pause|resume)` · `PUT /dialer/concurrency` |
| Review | `GET /review` · `POST /review/:id/(accept|override|keep|stuck|lost)` · `POST /review/bulk-accept {min_confidence}` |
| Tasks | `GET/POST /tasks` · `PATCH /tasks/:id` |
| Reports | `GET /funnels/:id/reports/(funnel|velocity|speed|reach|dropoff|stuck|cost|accuracy|lists)?range=&list=&owner=&cohort=` |
| Events (SSE topics) | `dialer`, `lead:{id}`, `list:{id}`, `funnel:{id}`, `review` |

---

## 14. Backend flows and jobs

### 14.1 Import commit
`POST /imports/:id/commit` → job `import-commit`: for each `import_rows` row with status ok/fixed in `row_no` order → upsert `contacts` (phone) → create `leads` (position = running index, funnel + stage = list entry stage or mapped stage) → `consent_records` → `stage_history(entry)` → `lead_activities(import)` → `rules.evaluate(lead)` → progress via SSE `list:{id}`. Batches of 500 rows per transaction; idempotent on `import_job_id + row_no`.

### 14.2 Rules engine (`rules.evaluate`)
Input: lead + stage call behaviour + list rules + legal-hours config + tenant flags. Order of checks: tenant `outbound_enabled` → list running → stage call behaviour = auto_call → lead not DNC → consent present → lead not paused → attempts < max (stage override or list) → window (lead TZ) → legal hours → daily cap → credits > 0 (and list cap). Output: `call_queue` row (`due_at` now or next window open) or `blocked_reason`; for stage behaviour task/stop/handoff → create task / stop / run hand-off instead. Every evaluation writes a `lead_activities(rule)` entry so the card explains itself.

### 14.3 Dialer worker
Tick every 10 s per tenant with queued rows (Redis sorted set `dialq:{tenant}:{list}` scored by `due_at`, then `position`):
1. Available outbound slots = plan cap − inbound reserve − active outbound calls (Redis `active_out:{ws}`), capped by list concurrency, daily cap and a credits check (balance ≥ 2 × expected call credits).
2. Pop due rows in order; for each: re-run quick checks (DNC, window, consent) → build stage context (`current_stage`, `stage_goal`, `stage_must_not`, `fields_still_needed`, `approach`) → `POST /v2/create-phone-call {from_number: list's Oraly number, to_number, override_agent_id, override_agent_version: latest_published, retell_llm_dynamic_variables, metadata: {tenant_id, lead_id, list_id, funnel_id, stage_id, attempt_no, direction: outbound}}` → `dial_attempts` (placed) → `call_queue.state = dialing`.
3. Retell `call_started` → `calls` row linked to lead; `call_ended` → outcome classification (`dial_no_answer`, `dial_busy`, `dial_failed`, `voicemail_reached`, `user_hangup`, `agent_hangup`…) → metering (unchanged) → retry scheduling from the cadence (stage override else list) → re-enqueue at head with `reason=retry`, or finalise (max attempts → `status=unreachable`, `lost_reason=unreachable` if the funnel says so, task if configured).
4. Fairness across lists: round-robin by list on each tick. Starvation guard: a retry due more than 1 window-day ago is promoted.

### 14.4 Post-call processor
On `call_analyzed` with `lead_id` (or inbound match): job `lead-postcall` implementing §9.2 with the §5.6 guard rails. LLM call timeout 20 s, retry once; on failure the call is marked "Processing failed — retry" on the card and queued for manual review. Idempotent on `call_id`.

### 14.5 Scheduled jobs
| Job | Schedule | Logic |
|---|---|---|
| `window-opener` | every 5 min | for leads blocked on window: when the lead-TZ window opens, move `due_at` to now |
| `stuck-detector` | hourly | days-in-stage and required-field rules → `stuck=true`, run stage stuck playbook once, owner alert |
| `time-rules` | hourly | evaluate stage time rules (e.g. no-show tasks) |
| `handoffs` | daily | hand-off rules with `after_days` → create linked lead in target funnel |
| `intake-fetch` | per channel interval | fetch URL, import new rows via saved mapping |
| `intake-mail` | on inbound mail | parse attachment → import job |
| `daily-caps-reset` | 00:00 workspace TZ | reset daily dial counters |
| `list-finisher` | every 10 min | lists with no queued/dialing rows and no pending retries → `finished`, owner email with funnel results |
| `lead-digest` | 07:00 workspace TZ (part of existing digest) | per funnel: reached, moved, stuck, review count, tasks due |
| `crm-reconcile` | nightly | dial_attempts vs Retell list-calls (direction=outbound); orphan calls attached by `metadata.lead_id` |

### 14.6 Inbound-to-lead matching
On any inbound `call_analyzed`: look up `contacts` by `from_number`; if found and an open lead exists → attach call, run the post-call processor against that lead's funnel; if not found → create contact + lead in the default funnel (or the Inbound Call funnel if the workspace created one) with `source = "Inbound call"`, stage from the receptionist outcome (appointment request → Appointment; message taken → Contacted). Toggle per funnel ("Create leads from inbound calls", default on for the default funnel).

---

## 15. Compliance and abuse controls

- **Outbound gate (per workspace):** business verification (legal name, website, address, contact, nature of calls, sample script) submitted in portal Settings ▸ Outbound calling → reviewed in admin SA11 → `kyc_status=approved` → `outbound_enabled`. Until then: imports and funnels work, dialing is disabled with a clear banner.
- **Consent:** per-lead `consent_source`; per-list attestation; leads without consent never enter the queue; consent withdrawal on a call → `dnc` within the same post-call job; DNC check also against the admin global blocklist and the tenant blocklist; DNC blocks hand-offs. Hook point for a National DNCL / DNC-scrub provider is a stub (`dnc.scrub(list)`) — provider selection delegated to counsel/ops.
- **Calling hours:** legal floor per country in admin (US default 08:00–21:00 local, CA 09:00–21:30 weekdays / 10:00–18:00 weekends per CRTC — to be confirmed by counsel); customer windows can only narrow, never widen; lead TZ derived from number/state when not supplied.
- **Caller identification:** agent states business and purpose in the first sentence; `from_number` is the tenant's own Oraly number; verified caller ID required; branded caller ID offered later (Retell add-on).
- **Rate and abuse:** daily dial caps, max attempts per lead, per-list credits cap, global kill switch "Pause all outbound" (admin SA12), fraud rules in SA11 extended with "high dial volume on new workspace".
- **Records:** every dial, consent record, DNC entry, rule evaluation and AI decision is retained with the call; export on request (data-request flow in admin).
- **Recording consent:** outbound calls to two-party jurisdictions get the consent line automatically (reuses the portal rule, keyed on the lead's state/province when known, otherwise the stricter setting).

---

## 16. Phasing

| Phase | Scope | Exit criteria |
|---|---|---|
| **P0 (adds to the portal P0 spike, +1 wk)** | `create-phone-call` with `override_agent_id` + dynamic variables; confirm outbound disconnection reasons and that unanswered dials cost nothing; verified caller ID purchase via API; voicemail detection flag; Anthropic extraction prompt on 20 sample transcripts against the default funnel (stage-decision accuracy ≥ 85 % vs human) | measured on the sample set |
| **P1 — CRM MVP (6–8 wks, overlaps portal P1 back half)** | §5 funnels: templates `inbound_lead`, `outbound_list`, `quote`, `appointment`; builder C6 (stages, goals, exit criteria, capture fields, call behaviour, stuck playbook); movement rules incl. skip and manual; hand-offs and time rules (Growth+); C1–C5, C7–C9, C10 (funnel, velocity, speed, reach, drop-off, stuck, cost); §7 rules incl. FIFO, windows, retries, caps; §8 templates; §9 full post-call pipeline; inbound-to-lead matching; outbound gate, consent/DNC, legal-hours config; credits/limits per §11 | 5 design partners running ≥ 500 leads each through at least two funnel types; reach-to-card update < 90 s; stage-decision auto-apply precision ≥ 90 % on accepted reviews; no dial outside window/consent in audit |
| **P2** | `reengagement` and `inbound_calls` templates, industry variants, "Test with a transcript" on past calls, scheduled fetch + drop endpoint, Oraly lead form, voicemail message drop, callback scheduling with live calendar tool (once portal P2 ships), funnel targets and SLA alerts, per-workspace rubric tuning from review overrides, list A/B of agents, C10 AI-accuracy block | — |
| **P3** | SMS/email steps inside a funnel stage, lead scoring model, agency multi-workspace views, public API for intake | — |

---

## 17. Decisions needed

1. Confirm the module name in the UI: **Leads** (recommended, plain) vs "CRM"; and "Funnel" as the user-facing word (recommended; matches how you describe it).
2. Funnel templates in P1: the four proposed (inbound lead, outbound list, quote, appointment) vs inbound + outbound only.
3. Default stage set for the Inbound Lead Funnel (Appendix A.1) and whether "Reached" is a separate stage or merged into "Contacted" (recommended: separate — it is where most stuck leads sit and worth measuring).
4. Which automated intake channels ship in P1 — email-in only (recommended) vs also scheduled fetch/drop endpoint.
5. Default cadences (inbound 15 min → 2 h → next morning; outbound 2 h → 1 d → 3 d; max 4 attempts) and stuck thresholds (2 touches / 5–10 days).
6. Auto-apply confidence threshold default (0.80); regressions always to review (recommended).
7. Plan limits in §5.10/§11 and whether outbound is Growth+ only (recommended: Starter can import and run ≤ 100 dials/day after KYC, 1 funnel).
8. Voicemail behaviour in P1: hang up silently (recommended) vs leave a message.
9. Inbound calls auto-create leads by default (recommended: on, default funnel) vs a dedicated Inbound Call funnel.
10. Counsel sign-off items: consent attestation wording, legal calling-hour floors per country, DNC scrub provider, recording-consent line for outbound.
11. Caller ID: require verified caller ID for all outbound (recommended) and charge 15 credits one-time, or absorb.

---

## Appendix A — Funnel templates with full stage definitions

### A.1 Inbound Lead Funnel (default) — `inbound_lead`

| # | Stage | Type | Goal for the agent | Exit criterion | Capture fields (req-to-exit *) | Call behaviour | Stuck playbook |
|---|---|---|---|---|---|---|---|
| 1 | New | open | — (not yet called) | a dial attempt was made | — | auto-call on arrival | — |
| 2 | Contacted | open | Reach the person; confirm identity and that they made the enquiry; learn the need | lead reached, right person, need understood | right_person*, need* | auto-call retries (cadence) | retry alternate opening ("quick 2-minute question") |
| 3 | Reached | open | Understand need, timeline, budget range; confirm who decides; handle objections | budget range AND timeline stated; decision maker confirmed | budget*, timeline*, decision_maker*, objections | auto-call if callback; else task "Follow up" | task for human |
| 4 | Qualified | open | Propose the next step (consultation / quote / visit) and get a date/time | next step agreed with a date/time or explicit commitment | next_step*, preferred_time*, location | task "Confirm & send details" | hand off to Re-engagement after 30 d |
| 5 | Appointment | open | Confirm the appointment; answer logistics | appointment confirmed by the lead | appointment_time*, location | task "Confirm appointment"; stop auto-call | time rule: no-show task 2 h after appointment_time |
| 6 | Won | won | — | purchase/booking completed | value | stop | — |
| 7 | Lost | lost | — | explicit refusal / disqualified / unreachable | lost_reason* | stop; hand-off rule Lost(not_now, no_budget) → Re-engagement 60 d | — |

Stuck examples the rubric recognises: "call me later" twice without a date; same objection (price, waiting on partner) in two touches; budget never stated after two Reached calls.

### A.2 Outbound List Funnel — `outbound_list`
New → Contacted (reached & right person) → Interested (interest ≥ 3/5 and a need stated; must-not: hard sell) → Appointment (date/time agreed) → Won / Lost. Cadence 2 h → 1 d → 3 d; stuck 2 touches / 10 days; Lost(not_interested) stops, Lost(not_now) → Re-engagement 90 d.

### A.3 Quote / Estimate Funnel — `quote`
New → Contacted → Site visit booked (visit_date*, address*) → Quote sent (quote_amount, sent_date; entered manually or by the business via task) → Follow-up (agent goal: get a decision or an objection; exit: decision stated) → Won / Lost. Time rule: Quote sent + 3 days without decision → auto-call "follow-up" (agent must not discount). Stuck at Follow-up ×2 → task "Owner calls personally".

### A.4 Appointment Funnel — `appointment`
Requested (preferred_slots*) → Scheduled (appointment_time*; set by the business via task or by the agent proposing from a list of slots given in the brief) → Confirmed (agent goal: confirm attendance 24 h before; exit: lead confirms) → Showed / No-show (time rule: appointment_time + 2 h → task "Mark showed / no-show"; No-show → auto-call "rebook") → Rebooked (loops to Scheduled) → Won / Lost.

### A.5 Re-engagement Funnel — `reengagement` (P2)
Dormant → Re-contacted (permission-first opening; must-not: pressure) → Interested → Appointment → Won / Lost. Entered only by hand-off or by importing a "dormant" list; cadence 1 attempt per week, max 3; DNC strictly honoured.

### A.6 Inbound Call Funnel — `inbound_calls` (P2, optional)
Called in → Message taken → Called back (task for human; or auto-call if the receptionist captured consent) → Resolved / Booked → Won / Lost.

## Appendix B — CSV template (download in C3)

```
phone,first_name,last_name,email,company,source,consent_source,consent_timestamp,timezone,language,interest,stage,notes
+15145550199,Maria,Lopez,maria@example.com,,Oct webinar,web_form,2026-10-03T14:22:00Z,America/Toronto,fr-CA,Kitchen renovation,,"Asked about financing"
```
Header synonyms auto-mapped: `phone|mobile|tel|telephone|phone_number`, `name|full name` (split on last space), `firstname|first`, `lastname|last|surname`, `e-mail|mail`, `org|organisation|business`, `campaign|utm_campaign|source`, `tz|time zone`, `lang|locale`, `status|funnel stage` → stage.

## Appendix C — Post-call extraction schema (Anthropic structured output)

```json
{
  "attempt_outcome": "reached|no_answer|busy|voicemail|failed|wrong_number",
  "summary": "≤ 60 words",
  "sentiment": "positive|neutral|negative",
  "field_updates": [{"key": "budget", "value": "25-30k", "confidence": 0.92, "evidence": "…"}],
  "objections": ["comparing two quotes"],
  "commitments": [{"by": "lead|business", "text": "…", "due": "2026-10-15"}],
  "callback": {"requested": true, "at": "2026-10-10T15:00:00-04:00", "evidence": "…"},
  "stage_decision": {
    "decision": "advance|stay|stuck|lost|regress",
    "to_stage": "Qualified",
    "skipped_stages": [],
    "confidence": 0.91,
    "evidence": ["we have about 25 to 30 thousand set aside", "ideally January"],
    "reason": "Budget and timeline stated; decision maker confirmed",
    "lost_reason": null,
    "stuck_blocker": null
  },
  "next_action": {"type": "dial|task|stop|handoff", "at": "…", "task_title": "Send pricing"},
  "dnc_requested": false
}
```
Inputs: transcript, lead card (fields + history summaries + previous lead summaries on re-entry), the funnel definition (stage order, goals, exit criteria, capture fields with required-to-exit flags, must-nots), list rules (so "callback" is honoured), locale. Code applies the §5.6 guard rails after the model returns.

## Appendix D — Sync list for the other two specs

| Document | Change |
|---|---|
| `voice-agent-portal-spec.md` → v0.4 | Nav gains **Leads**; D9 pointer to this document; template catalogue gains `lead_followup` and `appointment_outbound`; §19 phasing: outbound moves from P2 to P1 (CRM); Settings gains **Outbound calling**; D1 Home gains "Tasks due today" and "Needs review" tiles; §15 gets `calls.lead_id`, `calls.dial_attempt_id`, `tenants.outbound_enabled`, `tenants.kyc_status`, `phone_numbers.verified_caller_id`, `agents.funnel_id`, `agent_versions.playbook_version` |
| `super-admin-spec.md` → v0.2 | SA2 Customer 360 gains **Leads & dialing** (lists, funnels, dial stats, outbound status, KYC decision, pause outbound); SA5 Packs gain leads/dials/funnels/stages/intake limits and the attempt-fee + verified-caller-ID settings; SA6 gains the **funnel template** catalogue (stages, goals, exit criteria, industry variants, versioned); SA11 KYC in P1 with legal-hour floors per country and the global phone blocklist feeding DNC; SA12 kill switch "Pause all outbound" |
