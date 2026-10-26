# 0026 — Arabic and right-to-left in the customer portal

Date: 26 Oct 2026. Status: accepted. Builds on ADR 0017 (the portal foundation: static
export, no server, `next-intl`) and ADR 0008 (S3 + CloudFront). Spec: §12 (portal), §16
(error codes). The admin console is unchanged and stays English (ADR 0021).

## Context

The portal shipped English only. Every user-facing string was already a key in
`en.json`, read through `useTranslations` (ADR 0017), and `fr-CA` was declared but had no
catalogue. Arabic is the first second language, and the first right-to-left one.

Three things made it more than a second JSON file: the export has no server, middleware
or dynamic segments, so the usual `[locale]` route segment is unavailable; the shared
components (`@portal/ui`) said a few words of their own ("Close", "Loading") and were laid
out with physical `left`/`right` classes; and some copy reaches the screen from the API in
English (template names, lint findings, disconnection reasons).

## Decision

1. **`next-intl` without i18n routing.** The language is a per-browser choice, stored in
   localStorage under `portal:locale` (like the theme under `portal-theme`), else the
   browser's first supported language, else English. `LocaleProvider`
   (`src/i18n/locale-provider.tsx`) holds it in a small external store read through
   `useSyncExternalStore`, so the English static HTML hydrates without a mismatch and the
   stored language renders immediately after. URLs carry no locale: a switch is a
   re-render in place, so the route, its query and any half-filled form survive it.
2. **Direction before first paint.** `localeBootScript` (inline in the root layout's
   `<head>`) sets `<html lang dir>` from the same rules before the bundle loads, so a
   right-to-left reader never sees a left-to-right page first. `LocaleProvider` keeps
   them in step afterwards.
3. **`ar` uses Western digits** (`ar-u-nu-latn`, `intlLocale()`), for next-intl and every
   `Intl` call alike: credits, prices and E.164 numbers sit side by side on every page.
   `lib/format` reads `activeIntlLocale()` instead of the browser's locale; country,
   language and timezone names come from `Intl.DisplayNames` / `timeZoneName` in the
   portal's language. A formatted phone number is wrapped in a left-to-right isolate
   (U+2066…U+2069) on a right-to-left page, display only.
4. **`@portal/ui` takes its words and direction from `UiLocaleProvider`**, which also
   wraps Radix's `Direction.Provider` (menus, tabs, sliders, radio groups) and turns the
   toaster to the bottom-left. With no provider (the console) it is English and
   left-to-right, exactly as before; a label passed as a prop still wins.
5. **Logical CSS only.** `ms-/me-/ps-/pe-/start-/end-/text-start/text-end/border-s/e`
   replace the physical classes in the portal and `@portal/ui`; `Sheet`'s `left`/`right`
   sides are reading-order sides. Directional lucide icons are mirrored by one rule in
   `globals.css` (by their `lucide-<name>` class; media controls are not). Phone, email
   and URL inputs stay left-to-right. Free text (`Textarea`, transcripts, ticket
   messages, the script editor) is `dir="auto"`. The 30-day chart keeps a left-to-right
   time axis.
6. **English-only API copy is translated by id, never in place.** `useServerCopy()`
   (`src/i18n/server-copy.ts`) shows the API's text in English and the catalogue's line
   for the same id otherwise (template id, industry slug, lint `rule`, analysis field,
   `disconnection_reason`), falling back to the API's text for an id it does not know.
   A free sentence with no id (a job's `customer_reason`, an activation error) gives way
   to our generic line outside English; so does an unknown error code
   (`errorMessage()`). Nothing stored or sent changes. Two kinds of server text are
   matched **exactly** against their English source instead of by id, because someone
   can change them without a portal release: a pack's `badge`/`description` (staff edit
   the pricing config) and the call-forwarding guide (dial codes, `forwarding-guide.ts`).
   The translation is shown only while the server's line is still that source, with one
   `{destination}` allowed to vary; anything else is shown as the server sent it, so a
   changed dial code can never be shown from a stale translation.
   `server-copy.test.ts` imports the server's guide and the seeded pricing config and
   fails when they drift from the catalogue, or when a translation drops a dial code.
   Voice accents ("American") are vendor free text, translated by normalised name.
7. **Parity is tested.** `src/i18n/messages.test.ts` fails on a missing or extra key, a
   lost placeholder or rich-text tag, an empty translation, a message that does not
   format under Arabic plural rules (0, 1, 2, 3, 11, 100), or a line naming the voice
   platform. Universal Login follows through `ui_locales`; `ar` is in the customer
   tenant's `enabled_locales`.

## Consequences

- Both catalogues are in the shared bundle (Arabic: +32 KB gzipped). Loading Arabic on
  demand would show English, or nothing, in a right-to-left layout on every first visit,
  since there is no server to choose the catalogue.
- The language is per browser, not per account: a second device starts from its own
  browser language. Server-side copy (emails, the digest) stays English until there is a
  `users.locale` to read; nothing in the API changed.
- A template's `brief_prefill` (persona name, goal, rules) is stored into the draft in
  English when the agent is created, and so is shown in English on W2 in Arabic. It is
  the customer's data from then on, so it is not translated on display. Arabic prefills
  belong in the template files, chosen when `POST /agents` creates the draft.
- Adding a language is a catalogue, an entry in `LOCALES` / `LOCALE_NAMES`, and (if it is
  right-to-left) an entry in `RTL`; the parity test then holds it to the English keys.
- `Stepper`'s scroll row is `relative`: its `sr-only` step labels had escaped the row's
  clip and widened a 390 px page by 35 px, in English too.
