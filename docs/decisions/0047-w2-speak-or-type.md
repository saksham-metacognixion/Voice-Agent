# 0047 — W2 "Speak or type": guided questions that fill the brief (17 Nov 2026)

## Problem
W2 asks a small business owner to fill in a form of thirteen fields. Pramod asked (17 Nov, Phase 1)
for a second way in: the owner answers a few questions out loud or by typing, and the brief is filled
in for them to check. The task fixed the boundaries: the same questions on both paths, the same
structured brief, the existing W2 form as the review, the existing autosave and Generate untouched,
no new speech vendor, no call-path involvement (ADR 0009), Firefox on Type only.

## Decision
1. **Eight questions, one list** (`shared/schemas/src/brief-answers.ts`). `guidedQuestionId` is
   `business, role, hours, services, pricing, restrictions, handoff, extra`, asked in that order, and
   `GUIDED_QUESTION_FIELDS` is the only mapping to the brief:

   | Question | Brief fields |
   | --- | --- |
   | business | `about_business`, `address` |
   | role | `goal`, `agent_name` |
   | hours | `business_hours` |
   | services | `services`, `services_notes` |
   | pricing | `pricing` |
   | restrictions | `never_do`, `never_do_presets` |
   | handoff | `handoff_rules` |
   | extra | `anything_else`, `faqs` |

   `personality`, `ai_disclosure` and `documents` are out of reach of the questions and of the
   route: they are sliders, a three-way choice and an upload. `address`, `agent_name` and `faqs`
   joined on 17 Nov (addendum below).
2. **An answer is text, whichever way it was given.** Speak writes the recognised words into the
   same answer box Type uses (`addTranscript`), the customer can correct them there, and both end at
   one review and one request: `briefFromAnswersRequest {answers: {<question>: string ≤ 1 500}}`,
   at least one non-blank answer. There is no second data structure.
3. **`POST /agents/:id/brief/from-answers`** (owner/admin/editor, verified email, `prompting`
   module) turns the answers into `{brief: briefPatch}`. It is synchronous and stateless like
   `documents/extract`: agent and tenant are read and the transaction closes, then
   `PromptProvider.briefFromAnswers` is asked, and nothing is written. It obeys `pause_generation`,
   refuses a paused workspace, answers `NOT_CONFIGURED` without a key, counts 30 an hour per
   workspace (`ratelimit:brief-answers:{ws}`, `RATE_LIMITED`), and maps every provider failure to
   `503 UPSTREAM_UNAVAILABLE` with our own sentence. Answers are never logged.
4. **The gate is `modelBriefPatch`**: `repairModelBrief` then the existing `briefPatch`. Repair keeps
   only the fields of answered questions, trims and cuts text to the field limit, cleans the lists,
   keeps valid opening times, and turns a transfer without a dialable number or a read-a-message
   rule without its words into "take a message". It never returns an empty value, so a patch
   cannot clear a field. An answer that is not a JSON object fails the call.
5. **A phone number said without its country code is read as a national number of the workspace
   country** (`spokenNumber`), after `toDialableE164` has had its turn. ADR 0044 refuses a default
   region for a *typed* hand-off target because a `+` put in front of typed digits saved wrong
   numbers; here nobody says "plus one" aloud, a number carrying a `+` is never re-read, and the
   customer sees the E.164 result in the form before anything is generated.
6. **The model is asked for opening hours as a list** `[{day, open, close}]`, not the brief's
   `{days: {mon..sun}}` record. A structured decoder writes object keys in schema order: against the
   real model "Saturday to Thursday" came back as Saturday and Sunday only, and "Thursday through
   Monday" lost Monday. `repairModelBrief` folds the list into the record (and still accepts the
   record).
7. **The scripted provider answers from fixed rules**: each answer into its own field, lists split
   on commas and "and", the first "9 to 5" as weekday hours, a phone number in the hand-off answer
   as a transfer. Same answers, same brief, no key, no request; `ok_brief` and `raw` drive the
   repair and failure paths. It passes the same gate.
8. **The portal lays the patch over the form** (`applyBriefAnswers`, pure): answered text replaces
   the field, lists (`services`, `never_do_presets`, `handoff_rules`) are added to and never
   replaced, hours keep their time zone and closed dates, and a row still being typed survives. W2
   calls `form.setValue` for the changed fields only, so the existing watch → autosave path stores
   them and the existing unsaved-changes guard covers them. The result names the fields that
   changed and offers Undo (the values from before the apply). Generate is not called.
9. **Speech is the browser's** (`SpeechRecognition` / `webkitSpeechRecognition`), in
   `src/wizard/speech-capture.ts`. `speechSupported()` is the constructor plus "not Firefox" (Firefox
   can expose the constructor behind a flag with no service). Nothing is requested before "Start
   speaking". `SpeechCapture.cancel()` runs on unmount, `pagehide`, closing the questions, switching
   to Type and when a generation starts; `stop()` runs when the tab is hidden; a `stop()` whose
   `end` never arrives is cut after 4 s. Next and Previous wait while the microphone is on.
   Recognition language is the portal language (`en-US`, `fr-CA`, `ar-SA`).
10. **Answers in progress are kept in `sessionStorage`** per agent (`portal:guided-brief:<id>`), so a
    reload, or the reload the microphone-permission steps ask for, loses nothing.
11. **`MicDeniedHelp`** moved out of `test-call-panel.tsx` into its own file and is shared with W5;
    W2 replaces the last step ("start the call again") with its own.

## Alternatives considered
- **A voice agent that conducts the interview.** Refused by the task and by ADR 0009: it would put
  a model, and the voice platform, into something that only has to collect text.
- **A speech-to-text vendor on the server.** Would work in Firefox. Refused by the task; the browser
  API costs nothing and adds no processor of customer audio that we choose.
- **No model: copy each answer into its field.** That is what the scripted provider does, and it is
  not enough: hours, services and hand-off rules are structured, and spoken text needs tidying.
- **Send the current brief to the model and ask for a merge.** More tokens, slower, and the model
  could then rewrite a field nobody answered. The merge is code.
- **The W2 hours editor for the hours question in Type mode.** Two input shapes for one question
  would break "the same questions, the same output" and leave Speak with no equivalent.
- **Replace the lists.** A template's hand-off rule or a transfer number typed earlier would be
  lost to a spoken sentence.

## Consequences
- Measured against `claude-sonnet-5` (17 Nov, effort low): 2.5 to 4.6 s per request, about 3 000
  input and 150 to 400 output tokens. **The first request after the JSON Schema changes took 19.7 s
  and one 30 s budget ran out**: the structured-output grammar is compiled on first use. The route
  therefore runs on the provider's ordinary timeout (`GENERATION_TIMEOUT_MS`, 45 s) and the customer
  can retry with the answers intact.
- Chrome and Edge send the audio to Google's speech service, Safari to Apple's. That is the
  browser's own feature and the customer's permission prompt; the portal copy says the browser turns
  speech into text. A Chromium browser with the service switched off answers `service-not-allowed`
  or `network`, and the panel points to typing.
- The questions are asked in the portal language and recognised in it. An owner who wants to answer
  in another language types, or switches the portal language first.
- The system prompt for this call is compiled in (`BRIEF_ANSWERS_SYSTEM_PROMPT`), not an SA6 row.
- Tests: `shared/schemas/src/brief-answers.test.ts` (27), `backend/api/src/modules/prompting/brief-answers.test.ts`
  (19), `backend/api/test/prompting.e2e.test.ts` (9 new cases), `frontend/web/src/wizard/{guided-brief,speech-capture}.test.ts`
  (17 + 16). Browser check: `pnpm --filter @portal/web e2e:guided-brief` on the `e2e:wizard` stack
  (82 rows; `GUIDED_SCRIPTED=1` against a scripted API asserts exact fields, `GUIDED_NATIVE=1` adds
  Chrome's own recogniser). The recogniser is a stand-in the script drives and Firefox is simulated
  (its user agent, no recogniser); Edge, Safari and a real Firefox were not driven.

## Addendum, 17 Nov: address, agent name, FAQs and the "still empty" line
The first cut left `address`, `agent_name` and `faqs` to the form, so a customer who spoke every
answer still had to type them. They are now read from answers that already exist; there is no
ninth question.

- **Mapping.** The address comes from the business answer, the agent's name from the role answer,
  question-and-answer pairs from the last answer. The three hints say so in en, ar and fr-CA. The
  address and the name replace the field; FAQs are added to the list, never a question twice, never
  past twenty. A name outside 2 to 30 characters is dropped, not cut: a clipped name is a different
  name. A pair without both halves is dropped.
- **The model is told when not to write them**: an address only when one was given, a name only
  when the owner named the agent (never the owner's name, the business name or a job title), an FAQ
  only with both the question and its answer, and not repeated in `anything_else`.
- **Every field in `BRIEF_FROM_ANSWERS_JSON_SCHEMA` is now required, and empty means "nothing
  said".** With thirteen optional properties the structured-output endpoint held the request for
  two minutes and answered `400 Schema is too complex`; every request on the route timed out at
  45 s. Optional properties are what the grammar pays for. Required fields with `''` / `[]` compile
  in the ordinary time (6.5 s on the first request, 4.0 s after), and `repairModelBrief` already
  drops an empty value, so a patch still cannot clear a field. This also removes the 19.7 s first
  request recorded above. The scripted provider cannot find this; only a real call does. Rerun
  `e2e:guided-brief` against the real model after any change to that schema.
- **"Still empty".** After the answers are laid in, the result names the fields the form still
  holds nothing for (`emptyBriefFields`, `BRIEF_REVIEW_FIELDS` in `@portal/schemas`, form order).
  A field shown with a neighbour counts as filled by either half (services and their note, "must
  never" and its presets). The upload, the disclosure choice and the sliders are never listed.
- **Tests**: schemas 38, the API's `brief-answers.test.ts` 24, `e2e:guided-brief` 86 rows scripted
  and 84 against `claude-sonnet-5`. A Playwright pass (`docs/evidence/2026-11-17-w2-speak-or-type/`)
  drove the Type path, a real Generate and the locales in Chromium, a real Firefox and WebKit.
- **Still not proven by a person's voice.** Chrome's own recogniser starts and shows "listening" in
  headless Chrome, but audio injected as the microphone reaches it as silence, and a visible Chrome
  cannot be started from the build session. Safari does not exist on Linux. A spoken pass by a
  person in Chrome and Safari is the remaining check before this is called complete.

## Addendum, 18 Nov: the code review's ten findings

- **The patch never lands under a generation.** `GuidedBrief` reports `onSendingChange`, W2 holds
  Generate and Regenerate back while the answers are with the model (`GeneratePanel.blocked`), and
  a reply that arrives with the form locked or the page gone is dropped.
- **Sending the answers again replaces what the last apply added.** `applyBriefAnswers` returns
  `added` (the FAQs, services and hand-off rules it put in) and takes it back as `replacing`: those
  items are removed before the new ones go in, unless the customer edited them since. Exact-text
  matching could not catch a model rewording the same rule. W2 keeps `added` beside the Undo
  snapshot, in memory only.
- **Hours are set per day.** A day the answer did not name keeps its hours; "we are also open
  Saturday" no longer deletes Monday to Friday. An answer cannot close a day; the form does that.
- **The route has its own 20 s budget** (`BRIEF_ANSWERS_TIMEOUT_MS`), not the 45 s generation one.
  The slow first request that motivated 45 s went away with the all-required schema (6.5 s).
- **The hourly window counts answers read, not requests sent**: read before the provider, counted
  after it answered, as the test-call window does. An outage no longer uses up the 30.
- **A non-JSON answer is logged by its length, never quoted** (`quoteOutput: false`): the model's
  output restates the customer's answers.
- **Speech**: "Record again" keeps the answer until the first new phrase is heard; the 4 s stop
  grace keeps the phrase in flight before cutting the session; a final result that begins with the
  previous one delivers only the new words (Chrome on Android is reported to repeat itself in
  continuous mode, not confirmed on a device).
- Review's "Back" opens question 8 as a question, with Previous working.
