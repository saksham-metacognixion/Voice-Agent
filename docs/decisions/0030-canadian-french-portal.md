# 0030 — Canadian French in the customer portal

Date: 27 Oct 2026. Status: accepted. Amends ADR 0028 §5 ("Arabic, not fr-CA"). Builds on
ADR 0026 (Arabic and right-to-left: next-intl without routing, per-browser choice,
pre-paint `<html lang dir>`, API copy translated by id). Spec: §W3, §12.

## Context

ADR 0028 §5 replaced D16's fr-CA catalogue with Arabic, because the product was being sold
to Arabic speakers. Later the same day the owner asked for French back **as well**: the
portal serves both markets, so it now speaks English, Arabic and Canadian French.

The agent side never lost French. W3 offers `fr-CA` and `fr-FR` as agent languages, the
gateway sends the explicit locale array (ADR 0003 §6), and voices are ranked by accent.
What was missing was the portal's own interface. The customer Auth0 tenant already lists
`fr-CA` in `enabled_locales` (`infra/auth0/tenant.customer.yaml`).

## Decision

1. **A third locale, `fr-CA`**, in `LOCALES` beside `en` and `ar`, with a complete
   `src/i18n/messages/fr-CA.json`. The tests that guard Arabic (same keys, same
   placeholders and tags, every line formats under the locale's plural rules, no straight
   apostrophe before a brace, no platform name, the forwarding guide's dial codes, a line
   for every server reason and lint rule) loop over `LOCALES` and so guard French too.
2. **The id keeps its region.** `fr-CA` is what Auth0 receives as `ui_locales`, the tag on
   `<html lang>` and the `Intl` locale, so one id means the same thing everywhere.
   `matchLocale()` resolves a browser's tag to a portal language: the same tag, else the
   same base language. A `fr-FR` or bare `fr` browser therefore gets the Canadian
   catalogue, and an `ar-AE` browser the Arabic one, as before. `localeBootScript` mirrors
   it. A stored choice must be an exact id.
3. **Québécois business French**, vouvoiement, sentence case, `’` never `'`, a no-break
   space before `:` and inside « », none before `?`/`!`/`;`. One glossary for every screen
   (workspace → espace de travail, pack → forfait, plan → formule, brief → fiche, top-up →
   recharge, email → courriel, forwarding → renvoi d’appel, "what your agent knows" → « ce
   que votre agent sait »). Product names (Oraly, the pack names), carrier names, star
   codes and `{placeholders}` are never translated.
4. **Left to right**, digits as `Intl` gives them for `fr-CA` (`1 234,5`, `49,00 $`). Only
   Arabic is in `RTL`.
5. **W3 puts French first for a French reader**: `fr-CA`, `fr-FR`, then the launch set,
   then the Gulf Arabics — the same shape as Arabic's Gulf-first list (ADR 0027).
6. **The website widget** (`/embed/`) speaks the agent's language through `matchLocale`,
   so a French agent's button is in French; a language the portal does not have falls back
   to English.

## Alternatives considered

- **`fr` as the id with `fr-CA` only as the `Intl` tag.** Shorter, but Auth0 and `<html
  lang>` would receive `fr`, and the region would live in a mapping instead of the id.
- **Translating only the wizard first.** The catalogue test refuses a partial locale, and
  a reader switched to French halfway through would land on English screens.

## Consequences

- Every new user-facing string ships in `en.json`, `ar.json` **and** `fr-CA.json`.
- The admin console stays English (ADR 0021).
- Customer emails remain English: no sender reads a language today, for Arabic either.
- The French copy was machine-translated against one glossary and checked by the
  catalogue tests. A native Québécois reader should review it before it is marketed in
  Quebec; the money lines (W7, Wallet) and the forwarding guides first.
