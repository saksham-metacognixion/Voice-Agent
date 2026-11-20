# Brand — Oraly by MetaCognixion

Source: the logo and the brand sheet Pramod posted in `#oraly` (15 Sep 2026). This file is
the developer-facing version: what the colours are, where they live in code, and the rules
that are easy to break by accident.

**The product is Oraly.** "Oraly by MetaCognixion" is the full lockup; MetaCognixion is the
company behind it, not a second product name. Retell is never named anywhere a customer can
see (CLAUDE.md, Retell isolation) — the brand promise is ours.

## Palette

| Name          | Hex       | What it is                                                            |
| ------------- | --------- | --------------------------------------------------------------------- |
| Oraly Purple  | `#7B5CFF` | The one accent. Primary buttons, the selected state, focus rings, links |
| Electric Blue | `#22D3EE` | Secondary graphic colour — data, "live", the waveform's cool end       |
| Deep Navy     | `#0A0F1A` | Dark-theme background; light-theme text                               |
| Slate         | `#1E2433` | Dark-theme elevated surface (cards, popovers)                         |
| Soft White    | `#F7F8FB` | Light-theme background; dark-theme text                               |

These five are constants. Everything else — borders, muted text, success, warning, danger —
is derived from them, once per theme, in `frontend/ui/src/styles/globals.css`.

**In code you never write a hex.** Components use the semantic token: `bg-primary`,
`text-muted-foreground`, `border-border`, `bg-card`, `bg-sidebar`. The five brand colours are
also exposed directly (`bg-brand-purple`, `text-brand-blue`, …) for the rare case where
something must be exactly on-brand rather than semantically "primary" — a chart series, an
illustration. A component that needs a colour it cannot name adds a token pair to that file;
it does not reach for `bg-white`, `text-neutral-500` or a hex.

Two places the mapping is deliberate rather than literal:

- **Electric Blue is a graphic colour, not a text colour on white.** `#22D3EE` on Soft White
  is about 1.7:1. The light theme's `--info` is a darker cyan; the dark theme's is the brand
  hex, which is correct on Deep Navy.
- **Oraly Purple is the same hex in both themes.** It is the constant that makes the two
  themes one brand. Only the focus ring lightens in dark mode, so it stays visible on navy.

## The logo

**The files are the artwork Pramod supplied, not a redraw.** The waveform's gradient runs
diagonally across the bars and the wordmark is a licensed face; both lose something when
approximated, so the lockup is shipped as extracted PNGs with the white matte removed:

| File (in each app's `public/brand/`) | What it is |
| ------------------------------------ | ---------- |
| `oraly-lockup.png` / `-dark.png`     | Waveform + "Oraly" — the default, for headers |
| `oraly-full.png` / `-dark.png`       | The complete lockup with "by MetaCognixion" |
| `oraly-mark.png`                     | The waveform alone; one file serves both themes |
| `app/icon.png`                       | The waveform, square, as the favicon |

`-dark` differs only in the wordmark, which is Soft White instead of Deep Navy. The waveform
is never re-coloured — its gradient was made to sit on either surface.

```tsx
<Logo />                             // waveform + "Oraly" — headers, the wizard bar
<Logo variant="full" size="xl" />    // adds "by MetaCognixion" — sign-in, first contact
<Logo variant="mark" />              // the waveform alone — tight headers, avatars
```

Rules:

- **Import it; never rebuild it.** `Logo` in `@portal/ui` is the only way the logo reaches a
  screen. A hand-drawn SVG copy drifts from the artwork the moment either changes.
- **Do not recolour, rotate, outline or add effects.** The only sanctioned variants are the
  three above.
- **The by-line needs room.** At `sm` or `md` the "by MetaCognixion" line is a few pixels
  tall and reads as noise. Use `variant="full"` at `lg` or `xl`, and `lockup` everywhere else.
- **Clear space** is the width of one waveform bar on every side.
- Both themes are in the DOM and swapped by CSS, so the right wordmark is showing in the
  first painted frame. Do not switch them from JavaScript.

A new app copies `public/brand/` and passes `basePath` if it serves them from elsewhere.

## Voice

From the brand sheet: **Human conversations. Real outcomes.** and **From conversation to
action.** The product line is "the plug-and-play platform for AI voice agents that answer,
act and get it done". `oraly.ai` is the domain (ADR 0015).

In the product itself the copy stays plain and second-person — "Tell us about your business",
"Hear my greeting", "Your agent is ready". The brand lines belong on first contact (the
sign-in panel, marketing), not scattered through the wizard. All of it is keyed in
`frontend/web/src/i18n/messages/en.json`; no user-facing string is written inline.
