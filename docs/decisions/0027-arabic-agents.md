# 0027 — Arabic agents for Saudi Arabia and the UAE

Date: 26 Oct 2026. Status: accepted. Builds on ADR 0003 §6 (the explicit locale list
instead of `multi`), ADR 0012 (prompting: fixed rules in code), ADR 0020 §5 (vendor voice
clips withheld) and ADR 0026 (the portal in Arabic, which is the portal's language, not the
agent's). Spec: §W3 (voice and languages), §9.3–§9.4 (generation, platform rules).

## Context

A Gulf business could already pick "Arabic (Saudi Arabia)" on W3 — `ar-SA` is in the
platform's locale list — but the agent it got was not usable. The catalogue had no voice
with an Arabic accent, so the agent spoke Arabic with an American one; generation was told
`Primary language: ar-SA` and nothing else, so the script was formal Arabic (MSA), which
nobody says on a phone call; and the platform has no `ar-AE` at all, so an Emirati business
had nothing to pick.

Before building, we tested the platform end to end on the dev workspace (26 Oct,
`backend/api/scripts/arabic-stt-proof.ts`, results kept outside the repo):

- **Text.** A Saudi caller persona against a hand-written prompt on gpt-4.1-mini: every
  reply in Saudi Gulf Arabic (عشان، تبي، صح كذا), right facts, Arabic goodbye with
  `end_call`. Two slips: the female agent "Sara" said «أنا موجود» (masculine), and it wrote
  the phone number as one numeral, «٠٥٥١٢٣٤٥٦٧», which a voice reads as an amount.
- **Voice.** Six caller lines recorded in a Saudi and an Emirati library voice, played into
  a web call through Chrome's fake microphone, against agents on `ar-SA` in both
  transcription modes. Saudi: every intent understood, the phone number transcribed whole
  in three of four calls. Emirati: every intent understood, but «شو» was heard as «شموع»
  and the phone number was lost in both modes. English inside Arabic («الساعة four») was
  transcribed phonetically and the time lost, in both dialects. `fast` transcription
  (10 ms end of speech) cut a caller off and logged noise as "unintelligible" turns;
  `accurate` (300 ms) did not. The provider behind both modes is Deepgram.

The callers were synthetic voices, clean and on a browser call, not people on a phone line:
these numbers are an upper bound.

## Decision

1. **`agentLanguage` = the platform's locales + `ar-AE`** (`@portal/schemas`). Agent
   settings and the draft patch validate against it; `retellLanguage` stays the platform's
   list with its compile-time check against the SDK. `platformLanguage()` in the gateway's
   types sends `ar-AE` as `ar-SA` — the platform's only Arabic — and `platformLanguages()`
   maps the "also speaks" list the same way, so an Emirati agent that also speaks Saudi
   Arabic is one platform locale. The dialect is carried by the prompt and the voice. A
   locale the platform adds later moves from `agentLanguage` into `retellLanguage`.
2. **Arabic always transcribes `accurate`** (`sttModeFor()`), whatever the tier's stack
   says. Rule in code, not a stack field: it is a property of the language, not the tier.
3. **The dialect, the speaker's gender and how to say a number are a runtime block in
   code** (`modules/prompting/dialects.ts`, `## Language (fixed)`), appended by
   `runtimePrompt` after the documents and before the §9.4 block — never stored in
   `prompt_text`, so it reaches a live agent at its next sync without a regenerate and the
   Advanced editor cannot remove it. The gender comes from the **live voice**
   (`voices.gender`), so a voice changed on W3 after generation still gets the right forms.
   Generation gets `dialectSection()` too, so the greeting, the closing line and every
   phrase in the script are in the dialect; the feedback turn the same.
4. **Curated voices** (`modules/voices/curated-voices.ts`): two Saudi (Mona, Fahad) and two
   Emirati (Khalifa, Sultan) voices from the provider's public library, added to each
   platform workspace by `pnpm --filter @portal/api voices:import` (look before you add).
   The platform lists them as `custom_voice_<workspace>` with no gender or accent, so the
   import names each one (`platformName`) and the voice-cache job recognises the row by that
   name and fills in gender and accent (`Saudi` → `ar-SA`, `Emirati` → `ar-AE` in
   `ACCENT_LANGUAGES`). W3 shows the curated `name`. Their clips are filed under
   `curated:<key>`, not the platform id, so one recording serves every environment
   (`samples:voices` records them; the vendor clip stays withheld). They are ElevenLabs
   voices, so the existing rule makes them **Premium**.
5. **W3** offers `ar-SA` and `ar-AE`, first in the list when the portal is in Arabic and
   after the launch set otherwise. A Saudi voice ranks as "also speaks Arabic, with its own
   accent" for an Emirati agent. **The script is written on W2, before the language is
   chosen**, so an agent switched to Arabic still greeted callers in English (staging, the
   same evening). W3 and the D3 Voice tab now compare the draft's greeting with its main
   language (`scriptNeedsRewrite`: Arabic script or not — two Latin-script languages are
   not guessed at) and offer "Rewrite in <language>", W2's regenerate on the draft's
   settings. Nothing rewrites without the click: a regenerate replaces hand edits.
6. **The worker refreshes the voice catalogue on boot while a curated voice is missing
   from it** (`catalogueNeedsRefresh`), not only when it is empty or 48 h old — otherwise a
   deploy adding a curated voice waits for the 05:00 UTC tick.
7. **Captured phone numbers** (`captured-phones.ts`) read Eastern Arabic numerals and
   Arabic digit words («صفر، خمسة، وخمسة، ثنين…»), so the read-time check works on an Arabic
   call; the captured value is shown as written.

## Consequences

- **UAE is not "supported" yet.** Emirati callers are understood, but their phone numbers
  were not transcribed in the proof calls. Before UAE is sold: a test with native Emirati
  speakers on a phone line, the platform's custom transcription settings, and a request to
  the platform for `ar-AE` (the transcription provider is believed to have Gulf variants —
  not verified). The read-back rule and `captured-phones` flag a wrong number; they do not
  fix one. Saudi Arabia can go ahead.
- **No Emirati woman's voice** in the library. A female Emirati agent uses a Saudi voice.
  A cloned voice from a paid voice actor is the production answer for both countries:
  library voices can be withdrawn by their owners.
- English words inside Arabic are transcribed phonetically. Picking English as "also
  speaks" sends both locales; whether that helps was not measured.
- The curated voices are matched by name: renaming one on the platform dashboard makes it
  an ordinary unlabelled voice at the next voice-cache run. Staging and dev share one
  platform workspace today, so the voices added on 26 Oct are already on staging.
- KSA and UAE phone numbers are not bought through the platform's carriers; SIP import
  (option C) is the route, and open decision 4 (launch countries) still stands.
- `lint`'s `language_mismatch` does not know Arabic and stays silent for it; the script's
  instructions may be English around Arabic lines, which is what the proof prompt was.

## Addendum, 17 Nov 2026 — four Québécois French voices

Pramod chose four ElevenLabs library voices for fr-CA agents and asked for them on W3
with clear names and working previews, confirmed on a test call. They take the curated
path of §4 unchanged: entries `quebec-alexandre`, `quebec-adam`, `quebec-mathieu` and
`quebec-jeanne` in `curated-voices.ts` (platform names `<Name> - Quebec French`, accent
`Canadian French`, which `ACCENT_LANGUAGES` reads as `fr-CA` alone, so they rank native
for a fr-CA agent while a France-accent voice ranks as the same language in another
accent), `voices:import` on the shared dev/staging workspace on 17 Nov, and the worker's
boot refresh picked them up (`voice-cache: 358 of 358 voices refreshed`). Three are owned
by one library member and Mathieu by another; the owner ids were read from the provider's
shared-voices API, since the library page does not show them.

W3 shows them as Alexandre Boutin, Adam, Mathieu and Jeanne Mance (`name`); the
platform names stay `<First name> - Quebec French`, because the name is how a row is
recognised and the import had already written it. The task sheet's id for Jeanne Mance
ends in a hyphen (`K7gx0ylJdff0yjM2uVQS-`); the provider's ids are twenty characters and
the import resolved `K7gx0ylJdff0yjM2uVQS`, which is what the registry holds.

Consequences:

- They are ElevenLabs voices, so the existing rule prices them **Premium** at 1.5
  credits/min. Pramod confirmed that on 17 Nov; no pricing rule was added or changed.
- The four clips of ours were recorded on 17 Nov with `samples:voices curated:quebec-…`
  (fr-CA line, `frontend/web/public/samples/voices/`, filed as `curated:quebec-<name>`),
  so W3 plays them on every environment after the next portal deploy. The recorder had
  been producing no recording since ADR 0035: its throwaway agent did not ask for one,
  and off is now the platform keeping none. `sample-recorder.ts` sets `recording: true`.
  The recording box needs ffmpeg/ffprobe on `PATH` and `CHROME_PATH` on Linux.
- Production has its own platform workspace: run `voices:import` there at cutover. Its
  `custom_voice_…` ids will differ; nothing stores them outside that environment's
  `voices` table, and the clips are keyed by `curated:<key>`, not by id.
