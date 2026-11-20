# 0039 — The W1–W3 wizard close: Save and exit as the §6.4 dismissal, the footer, the industry catalogue, the brief's presets and free text, FAQ routing, the country default and the voice pick

Date: 5 Nov 2026. Status: **accepted**, with three calls made in session on the engineering
recommendation and awaiting the spec owner's sign-off (see "Decisions taken"). Spec: §6.4,
§7.3, §8 W1–W3, §9.3, §9.6. Amends ADR 0017 §2 (the gate) and ADR 0027 (the W3 filters).
Closes audit rows S-07, S-09, S-10 and Z-02 to Z-25 (`docs/audits/voice-agent-portal-phase-audit.md`,
addendum of 5 Nov).

## Context

The 29 Oct audit left the first three wizard screens short of §7.3 and §8 in fourteen
rows: no Back button on any step (S-10), Continue in the heading instead of the footer
(S-07), "Save & exit" rendered only once the wizard was over (S-09, because §6.4 sends an
unfinished workspace back to its step), seven industries where the spec asks for a
searchable forty (Z-03), the W2 "must never" presets, the services free text and the FAQ
plan routing missing (Z-07..Z-09), the generation stages named differently from the spec
and no "free" note, no confirm on Regenerate (Z-13, Z-15, Z-17), W3's main language fixed
at `en-US` whatever the workspace country (Z-20), the voice filters not the spec's set
(Z-21), and five rows never asserted (Z-02, Z-06, Z-11, Z-23, Z-25).

## 1. "Save and exit" is the §6.4 dismissal

§6.4 sends a workspace to `/onboarding/*` while it "has no published agent **and
onboarding not dismissed**". Nothing recorded a dismissal, so the button could not exist:
the dashboard's guard would have sent the person straight back. The dismissal is now a
column, `tenants.onboarding_dismissed_at`, written once by
`POST /workspace/onboarding-dismiss` (editor and up, like the step pointer; not audited,
it is a bookmark). `GET /workspace` returns it; `useSessionGate` reads it as
`dashboardAllowed`, so `/app` opens with the shell's existing "Your agent is not live
yet · Continue setup" band, whose link now goes to `stepPath(onboarding_step)` (it used
to point past the last implemented step, which is right only when the wizard is over).
Every reached step stays open; nothing clears the flag.

The button is on every step. The page it is on owns what "saved" means
(`WizardExitProvider` / `useWizardExit`): W1 creates the agent from the selected card and
advances the pointer, W2 flushes its autosave, W3 flushes its dial save and waits for it.
A step that throws keeps the person on the page with the error, so "exit" never drops an
edit it said it would keep.

## 2. Back and Continue in a footer

`WizardFooter`: Back as a link to the previous step at the start, the one primary action
at the end, a note beneath for what Continue waits for. On a laptop it sits at the end of
the content; below `sm` it sticks to the bottom of the screen over the safe area, as
§7.3 asks. W1 has no Back. W2's Continue moved out of the Generate panel, so once a script
exists the panel holds no primary button (one per screen). W5, W6, W7 and the knowledge
page took the same footer, since S-07 named W5 and W6.

## 3. The industry catalogue

The spec names the count (≈ 40), the businesses it was written for (§3) and the example
industries of the templates, but not the list. `INDUSTRY_GROUPS` in `@portal/schemas`
is the list: 48 slugs in eight groups (health, home services, personal care,
professional, property, automotive, hospitality, education and care), every existing
template tag among them unchanged (`dental`, `plumbing`, `auto`, `legal`, `salon`,
`real_estate`, `restaurant`). `agents.industry` stays a free string, so an agent created
before this keeps its value and the picker shows it. The picker is a new `Combobox` in
`@portal/ui` (a Radix Popover with a search box as the `combobox` and the list as its
`listbox`; arrow keys, Enter, Escape, Home and End), because Radix's Select has no text
input. Names are `wizard.w1.catalog.industries.<slug>` in the three catalogues.

## 4. The brief: presets and the services free text

Two fields join `brief` (a JSON column; no migration):

- `never_do_presets: ('no_prices' | 'no_medical_advice' | 'no_time_promises')[]` — the
  §8 #8 checkboxes, stored as ids so the portal shows them in the reader's language.
  `briefForModel` spells them out as sentences ahead of the free text in the one
  `must_never_do` field the model already knows. The templates' `brief_prefill` tick
  their own (receptionist: prices and times; after-hours: medical advice; appointment
  and restaurant: times; lead qualification: prices) and keep the rest as text, so "template
  defaults checked" holds from the first render.
- `services_notes` (≤ 500 chars) — §8 #5 "tag list (chips) + free text". Sent to the model
  beside the chips.

`briefPatch` takes `null` for the note (QA-006); the array clears with `[]` like the others.
`parseBrief` repairs per field, so a row written before this reads with both at their
defaults.

## 5. FAQ routing (§8 #7)

"Starter: injected into prompt; Growth+: optionally moved to KB." The pairs always go into
the script. `FaqRouting` reads the `knowledge_base` gate from `GET /flags` (never a plan
name) and, when it is on, offers "Move to what your agent knows": one `text` source
through `POST /agents/:id/knowledge` (the Q/A pairs, blank-line separated) and the
brief's list emptied, so the answers are in one place. Without the gate the note names
the cheapest pack that has it (`cheapestPackWith`, from `GET /pricing`). The same body
serves W2 and the D3 Brief tab, which is where a paid workspace will meet the button.

## 6. The W2 Generate panel

The three stages are named as §8 names them and light on the worker's own frames:
`generation_started` → "Reading your brief", `generation_progress` (first token) →
"Writing the conversation", `generated` → "Setting up analysis". There is no frame between
the last token and the stored version, so the third stage is ticked at the moment it
finishes rather than shown running on a timer. "Free. No credits used." sits under the
button. Regenerate opens a `ConfirmDialog` ("This rewrites the conversation from your
brief; your test feedback is kept.", plus the hand-edit warning); Cancel changes nothing.
A failed request and a `generation_failed` frame both raise the toast "Couldn't generate.
Try again." beside the existing inline alert.

## 7. W3: the country default, the voice pick and the filters

- **Main language from the workspace country.** `defaultAgentLanguage(country)` in
  `@portal/schemas` (US, CA → `en-US`; GB, AU, NZ, IN → their English; SA → `ar-SA`;
  AE → `ar-AE`; FR, DE, ES, MX, BR, PT, IT, NL → theirs; else `en-US`) is applied by
  `POST /agents` from `tenants.country`. The platform has no `en-CA` (ADR 0003 §6), so a
  Canadian business using the portal in French is started on `fr-CA` instead: W1 sends
  `createAgentRequest.primary_language` from `startingLanguage(country, portalLocale)`.
  The language lives on the draft from then on; a later country change in Settings does
  not rewrite a chosen language.
- **Automatic voice.** A draft with no voice gets the first voice that sounds native in
  the main language at the template's tier, with a toast naming it; after a language
  change made on the screen, a voice that is not native in the new language is replaced
  the same way ("if selected voice unsupported → auto-pick default and toast"). A voice
  someone chose and saved is never swapped on a mere reopen.
- **Filters.** Gender, tier and the spec's **accent** (applied in the browser over the
  listed voices: the catalogue carries the accent, `GET /voices` does not filter on it),
  plus search and "Native accents only". The spec's "Only multilingual" is not offered:
  every voice on the platform speaks every locale we sell, and `is_multilingual` means
  "we cannot name one native language" (ADR 0027), so the filter would be a no-op.
  "Native accents only" is the meaningful opposite.
- **Sliders** are unchanged (speed 0.8–1.2 at 1.0, expressiveness 0–1 at 0.5) and now
  asserted: range, default, steps, Home/End, saved and restored.

## Decisions taken

1. Save and exit records a dismissal and the dashboard opens on it (§6.4 read literally).
2. The industry list is ours (§3); the spec gives none.
3. "Only multilingual" is replaced by "Native accents only" and an accent filter (ADR 0027).

The copy follows the spec's wording with one deliberate change: no em dash in anything
new ("Free. No credits used.", "Couldn't generate. Try again."), per the project's copy
rules.

Also recorded here, from the audit's own notes: Z-16 exceeds the spec (the script is
editable on W2, not only viewable: ADR 0018 / the W2 `PromptTab`); Z-24 stays amended by
ADR 0003 §9 (no text-to-speech route, the sample is a recording); Z-25 stays amended by
ADR 0027 (the rewrite in the new language is offered, never automatic).

## Alternatives considered

- *Encode the presets as sentences in `never_do`.* Would have cost the 500-character budget
  and shown English sentences to an Arabic or French reader. Rejected.
- *Add Save and exit without a dismissal and let `/app` bounce.* That is the S-09 bug.
- *Derive the W3 default in the browser only.* The API knows the country and the D3
  "+ New agent" path does not go through W1; the server default covers both, the portal
  adds the one thing the server cannot know (the portal's language).
- *Filter accents server-side.* One more query parameter for a list the browser already
  holds; not worth the contract change.

## Consequences and deploy steps

- `pnpm db:deploy` (one additive column), `pnpm db:seed` (the templates' presets; the
  seed upserts templates by id).
- `pnpm --filter @portal/api openapi:generate` ran; the contract gained
  `POST /workspace/onboarding-dismiss`, `workspaceResponse.onboarding_dismissed_at`,
  `createAgentRequest.primary_language`, `brief.never_do_presets` and `brief.services_notes`.
- A dismissed workspace sees the dashboard's empty states (no calls, a draft agent, the
  trial balance) and the "Continue setup" band; nothing there assumes a live agent.
- SA1's `onboarding_stuck` counts paid workspaces older than 7 days with the wizard
  unfinished; a dismissed free workspace is not counted, as before.
- Exit check: `pnpm --filter @portal/web e2e:wizard` (now 100 assertions).
