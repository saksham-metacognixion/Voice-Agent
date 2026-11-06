# 0040 — The W5–W7 wizard close, the knowledge and live pages, and the §12 frontend gaps: answer modes, Option B and C fields, the W7 summary, Keep/Undo, the leave-call prompt, visible step-save failures and the error boundary

Date: 6 Nov 2026. Status: **accepted**, with the calls under "Decisions taken" made in
session on the engineering recommendation and awaiting the spec owner's sign-off. Spec:
§8 W4–W7b, §9.6, §12.1–§12.3, §13.5, §13.9, §17. Amends ADR 0013 (the phone plan), ADR 0028
(the `custom` hours mode is kept beside the spec's three), ADR 0035 (the W6 default for the
allowed caller countries) and ADR 0017 §2 (a step write that fails now stops the page).
Closes audit rows Z-29 to Z-63 (`docs/audits/voice-agent-portal-phase-audit.md`, addendum
of 6 Nov); Full Scope 07.

## Context

The 29 Oct audit left the second half of the wizard, the knowledge page, the live page and
three §12 architecture items short of the spec in twenty rows: no confirmation before a
knowledge source is removed and no "Add FAQs" on the plan gate (Z-29, Z-30); the W5
scenario chips without their "Try saying" hint, the feedback card without Keep / Undo, one
generic line where the spec asks for per-browser microphone help and a text-only call to
action at a zero trial balance (Z-34, Z-35, Z-38); W6 with an optional area code and no
Suggest, no forward-mode radio, no SIP provider, transport or "I understand" gate, no
transfer pre-fill from the brief and no allowed-caller-countries field (Z-40 to Z-45); the
spec's three answer modes absent — the shipped `business` mode is the *inverse* of "Only
outside business hours" and "Only when I don't answer" had no representation (Z-43,
FAIL); W7 without a summary card, the 10 % / 20 % auto top-up choice, minutes per pack or a
support link on failure (Z-47, Z-49, Z-52); the live page without Copy, SIP instructions or
the next-steps checklist (Z-53, Z-55, Z-56); no global error boundary (Z-59); a failed step
write swallowed and the page moved on regardless (Z-61); and no "End your test call?"
prompt on route change (Z-63).

## 1. The answer modes (§8 W6, §13.9 check 6, D4)

`hours_mode` gains two values beside `always`, `business` and `custom`:

- **`outside_hours`** — the spec's "Only outside business hours": `decide()` reads the
  *workspace's* hours (the same `hours` the runtime cache carries for `business`) and
  declines the call as `hours` while the business is **open**, so the customer's own phone
  rings first; once closed, the agent answers. No schedule, or a zone the clock cannot
  read, cannot say "closed": the call is answered with the existing `hours_no_schedule` /
  `hours_invalid_timezone` warning, never refused for ever. W6 warns when the workspace
  has no hours and links to the brief.
- **`unanswered`** — the spec's "Only when I don't answer": nothing is declined on our side.
  The customer's carrier forwards only the calls they did not pick up (busy / no answer),
  so everything that reaches the number is one of those. `decide()` treats it like
  `always`; W6 notes that it belongs with a forwarded line.

`business` (D4, ADR 0028) and `custom` (D16) stay as they are. W6 offers the spec's three
(`ANSWER_MODES`); a plan saved with one of the other two keeps it on the list
(`answerModeOptions`), so reopening W6 never silently changes a saved choice. D4's Routing
lists all five. `hoursModeUsesSchedule()` is the one predicate the runtime cache and
`decide()` share. Prisma enum values are added in place (`ALTER TYPE … ADD VALUE`,
migration `20261106090000_w6_answer_and_forward_modes`), additive like the
`decline_reason` precedent.

## 2. Option B's forward mode, Option C's provider and transport

- `phone_plans.forward_mode` / `phone_numbers.forward_mode` (`always` /
  `busy_no_answer` / `outside_hours`, text columns, nullable): informational, as the spec
  says — the carrier does the forwarding — but kept so W6 restores it, the W7 summary
  shows it and the live page says which of the carrier's codes apply. Copied to the
  number at provisioning (`numberFieldsOf`), exposed as `forwarding.mode`; `POST
  /numbers/buy` takes it too.
- `sipCredentials.provider` (`twilio` / `telnyx` / `vonage` / `other`) and `transport`
  (`TCP` / `UDP` / `TLS`, the platform's default TCP) ride inside `phone_plans.sip_json`
  in clear beside host and username — neither is a secret — and the stored schema keeps
  them optional so a row sealed before they existed still opens with the defaults. The
  transport reaches the platform's `import-phone-number` (`transport`); the provider only
  picks the instructions. Both are returned on the plan and the number (never the
  password, as before).
- The "I understand this requires configuring my carrier" checkbox is W6's gate (Continue
  refuses without it); it is not stored. A saved SIP plan was saved past the gate, so
  reopening W6 shows it ticked.

## 3. The SIP origination address

`SIP_ORIGINATION_URI` (one per environment, read only by `sipOriginationUri()` in
`common/env`) is returned as `phoneNumberResponse.sip.origination_uri`, null when unset.
The live page's `SipSetupGuide` and D4's SIP section show it with a copy button and the
provider's steps (`sipGuideSteps` names the steps, the catalogue carries the words); unset,
both say to ask support rather than show a guessed address. The platform's own name is
never on the page.

## 4. W6: the rest of the fields

- **Area code** is required for a local number on W6, as §8 W6 says ("✓ (local)"); the
  API keeps it optional for D4's "Add number". **Suggest** (`suggestAreaCode`) fills it
  from the workspace's time zone, the only location A3 records (the spec names the
  address or city, which the workspace does not hold); a zone the table does not know
  falls back to the country's largest city, and the hint says which. Only ever a
  preference: provisioning widens to a neighbour when the code has no stock (ADR 0013).
- **Transfer targets** start from the brief's transfer rules the first time W6 opens
  without a saved plan (`prefillTransferTargets`: the rule's condition is the label, one
  row per number). A saved plan comes back as saved.
- **Allowed caller countries** (`AllowedCountriesField`) default to the workspace's
  country plus US and CA (`defaultAllowedCountries`, §17 "allowed inbound country default
  = workspace country (+US/CA)") on a first visit; an empty list means no restriction and
  the copy says so. Enforced by `decide()` since ADR 0035.

## 5. W5: chips, Keep / Undo, microphone help, the trial call to action

- The scenarios are **chips** (`aria-pressed` buttons, up to five); pressing one shows
  "Try saying: …" for that scenario alone, so a phone screen is not five quotes long.
- The feedback card is the spec's diff card: "What changed", **Keep** (dismiss) and
  **Undo** (`POST /agents/:id/draft/select {version_no: base}` — §13.5 step 2, no model
  call; the patched version stays in the history). `useFeedback` remembers the base
  version in localStorage beside the job id, so a refresh mid-patch can still undo.
- Microphone denied shows the steps for the browser in use (`detectBrowser` on the user
  agent: Chrome, Edge, Safari, Firefox, else generic), from the catalogue.
- At a zero balance the panel's alert carries a button: on the trial, "You have used your
  free test minutes" → W6 (the spec's "activate" CTA; W6 is the next step and W7 follows
  it); after a pack, the wallet from D3. The panel takes the destination as a prop.

## 6. W7: the summary, the top-up choice, minutes, support

- `ActivationSummary` reads the draft (name, tier, voice by name from `GET /voices`,
  languages, documents), the pending plan (option, country, code, rental, answer mode,
  forward mode), the test-call count (`GET /calls?is_test=true` → `total`) and says what
  is not known rather than guessing (`summaryRows`, pure). Change links go to W2, W3 and
  W6. Knowledge sources are "added once you are live" (ADR 0024).
- Auto top-up offers **10 % or 20 % of the pack** (`TOPUP_PERCENTS`, `topupThreshold`,
  floor 10 credits as the API requires); the policy's `auto_topup_threshold_pct` picks the
  starting choice. The threshold still travels on `POST /wallet/checkout` and is stored by
  the server after payment, as before.
- Each pack card says the whole minutes it buys at the Standard rate, and at Premium when
  that differs (`packMinutes`, floored — never a minute the wallet cannot pay for), from
  `GET /pricing`.
- A failed activation row, and the "still waiting" state, carry **Contact support**: a
  `mailto:` to `NEXT_PUBLIC_SUPPORT_EMAIL` with the agent and activation id in the
  subject. The wizard has no Help page (the dashboard opens once live).

## 7. The knowledge and live pages

- Removing a knowledge source asks first (`ConfirmDialog`, Cancel / Remove source), as the
  menu already did; the delete runs from the dialog so an error stays in it.
- The plan gate's **Add FAQs** opens the agent's Brief tab (`agentPath(id, 'brief')`): W2 is
  behind the knowledge page now (ADR 0024) and refuses a finished wizard, and the Brief
  tab is the same form.
- The live page shows the number large, **Copy number** (`copyText`: the clipboard API,
  else the selection path; a failure says to copy by hand, never a false success) and
  **Call it now** (`tel:`); Option B's note names the forward mode; Option C gets the
  `SipSetupGuide`; everyone the **next-steps checklist** (`NextStepsChecklist`): invite a
  teammate, turn on the daily digest, add the website widget, plus "Test forwarding" for a
  forwarded line — each ticked from the rows the API holds (`liveChecklist`: members > 1,
  `new_message = daily`, widget enabled, forwarding confirmed or a test that landed) and
  linking to where it is done.

## 8. §12: the error boundary, step-save failures, the leave-call prompt

- `app/error.tsx` (below the root layout: translated, themed, "Try again" = Next's
  `reset`, a link home and to support) and `app/global-error.tsx` (the layout itself, plain
  markup). Both report through `reportError` with a `boundary` tag; the URL's query is
  stripped by the reporter as before. `/dev/crash/` throws on demand under `APP_ENV=dev`
  only, for the click-through.
- `useAdvanceOnboarding` **throws** when `POST /workspace/onboarding-step` fails. Every
  page that calls it keeps the person there with the message and turns Continue into
  Retry (W1 and W6 already caught; W3 and W5 now do; W2's post-generation advance toasts
  and Continue retries). The page never moves on to a step its guard will refuse.
- `LeaveCallPrompt`, mounted by the test-call panel wherever it is (W5, D3 Test): while a
  call is live, a link that leaves the page (`interceptsNavigation`, capture phase), the
  browser's back button (a sentinel history entry) and a button that navigates through the
  router (`guardNavigation`, W5's Continue) open "End your test call?" with **Stay on the
  call** / **End the call and leave**; Leave hangs up first. Reload and close get the
  browser's own dialog (`beforeunload`). Escape is Stay. It is a sibling of
  `useLeaveGuard` (unsaved edits, native confirm), not a replacement.

## Decisions taken

1. The spec's three answer modes are new `hours_mode` values beside the two shipped
   ones, not a replacement (§1). `outside_hours` with no schedule answers.
2. The area code is required on W6 only; D4 keeps it optional (§4).
3. Suggest reads the time zone, the one location the workspace records (§4).
4. The trial-zero call to action goes to W6, the next step (§5).
5. The SIP consent is a gate, not a column (§2).
6. "Add FAQs" opens the D3 Brief tab, since W2 is closed to a finished wizard (§7).
7. Promo codes are out of scope here (Full Scope 12), as the task says.

## Alternatives considered

- *Rename `business` to the spec's "outside hours" semantics.* Would have inverted the
  behaviour of every number saved with it since D6. Rejected.
- *A separate `answer_mode` column.* The spec maps all three to `hours_mode`; two
  columns would need a precedence rule. Rejected.
- *Keep the SIP origination address in the catalogue.* It differs per environment and
  the platform workspace; a build-time string would be wrong on one of them. Env var.
- *`window.confirm` for the leave-call prompt, like the unsaved-edits guard.* The spec and
  the task name two actions and the call must be hung up on Leave; a native dialog cannot
  do the second. A dialog of ours.

## Consequences and deploy steps

- `pnpm db:deploy` (two enum values, two nullable columns, additive). No seed change.
- `SIP_ORIGINATION_URI` in SSM per environment (`infra/scripts/ssm-put-env.sh`); unset,
  the SIP pages say to ask support.
- `pnpm --filter @portal/api openapi:generate` ran; the contract gained
  `phonePlanRequest.forward_mode`, `sipCredentials.provider` / `.transport`,
  `phonePlanResponse.forward_mode` / `.sip.provider` / `.sip.transport`,
  `phoneNumberResponse.forwarding.mode` / `.sip.provider` / `.sip.transport` /
  `.sip.origination_uri`, `buyNumberRequest.forward_mode`, and `hoursMode` now has five
  values.
- Four PostHog events: `live_number_copied`, `area_code_suggested`,
  `scenario_chip_opened`, `feedback_undone` (ids and indexes only).
- Exit checks: `pnpm --filter @portal/web e2e:wizard` (the chips, the leave prompt, Keep /
  Undo, the three answer modes, the countries, the area code and Suggest, the forward
  modes, persistence, the W7 summary, minutes and the top-up select, the error boundary)
  and `pnpm --filter @portal/web e2e:restaurant`; `backend/api/test/d6-numbers.e2e.test.ts`
  for the new plan fields and the transport reaching the platform.
