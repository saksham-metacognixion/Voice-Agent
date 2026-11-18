# antislop Delivery Gate: W2 "Speak or type" panel (17 Nov 2026)

Mode: during (chosen in session). Scope: the new panel on W2 (`guided-brief.tsx`), its copy in
en / ar / fr-CA, and `mic-denied-help.tsx`. The rest of the portal was not redesigned.

Design Read: a step inside an existing onboarding wizard for small-business owners, in the portal's
own token and component language (`docs/brand.md`, `@portal/ui`), dial ENERGY 1 / RHYTHM 1 / MOTION 1.

Reasons (R-31):
- Colour: existing tokens only. Purple marks the active mode and the forward action; red is the Stop button and the recording dot, the one moment that needs attention.
- Layout: one bordered card above the form, because the answers fill the form under it and the customer must see both.
- Typography: the portal's typeface and scale; the question is the largest text in the card because it is what the customer is answering.
- Spacing: the card's own padding and the wizard's 8-unit gap before the form, matching the cards beside it.
- Card: used once, to separate "answer questions" from "fill in the form".
- Icons: microphone = speak, keyboard = type, square = stop, arrows = previous / next. Each names its action.

## Block 1: Hard Gate (all "no")
- R-02 PASS: no em dash in the new copy or component (checked by search in the three catalogues and the new files).
- R-03 PASS: 390 px run in en, ar and fr-CA, every phase: no sideways scroll, every control at least 44 px (e2e rows "no sideways scroll at 390 px", "controls are finger-sized").
- R-17 / R-18 / R-36 / R-38 PASS: no statistics, testimonials or claims. "8 short questions" is `GUIDED_TOTAL`.
- R-23 PASS: no logo, avatar or illustration created.
- R-24 PASS: no navigation added.
- R-25 PASS: text uses existing token pairs (`text-foreground`, `text-muted-foreground` on `bg-card`, `text-accent-foreground` on `bg-accent`, `text-danger-foreground` on `bg-danger`), the pairs ADR 0025 set for AA. No new colour.
- R-26 PASS: every control was clicked in the browser run: Speak, Type, mode switch, Close, Start, Stop, Record again, Type this answer, Previous, Next / Skip, Check my answers, Edit, Back to the questions, Fill in my brief, Try again, Undo, Answer the questions again.
- R-27 PASS: empty (skipped answers, "Nothing to add yet"), loading ("Reading your answers…", button spinner, "Allow the microphone…", "Finishing what you said…"), error (request failed with retry; five recording errors each with a cause and a next step).
- R-28 PASS: no FAQ.
- R-32 PASS: native buttons and a textarea in visual order; focus moves to each new question, the review heading and the result; the base focus ring is kept (the mode switch has its own ring).
- R-33 PASS: written in source.
- R-34 PASS: light and dark both run (e2e row "dark theme", screenshot `guided-13-en-dark.png`).
- R-35 PASS: `pnpm --filter @portal/web e2e:guided-brief`, 82 rows, console clean; results in `e2e-guided-brief-results.txt`.
- R-37 PASS: direction is `docs/brand.md` and the existing design system.
- R-39 PASS for the panel: native elements, visible label on the answer box, `aria-pressed` on the mode switch, `aria-label` on the icon-only Close, icons `aria-hidden`, no looping motion, pointer cursor on the panel's enabled buttons. Open item for the owner: the shared `Button` has no pointer cursor anywhere else in the portal; one base-layer rule would fix that portal-wide and was left out of this task.
- R-40 PASS: no media, no third-party script, no performance number reported.

## Block 2: Purpose-Gate (all "no")
- R-01, R-07, R-10, R-12, R-13, R-22 PASS: no gradient, pattern, glass, glow or illustration; the card's shadow is the portal's `shadow-card`, as on every card.
- R-04 PASS: icons are the portal's set and each names its action (see reasons).
- R-06 PASS: no monospace or tracked uppercase.
- R-08 PASS: arrows only on Previous and Next, where they show direction (mirrored in Arabic).
- R-09 PASS: no badges.
- R-14 PASS: no feature cards.
- R-19 PASS: no animation; the progress bar's width transition is the shared component's.

## Block 3: Liveliness (all "yes")
- Dials set and held: ENERGY 1 / RHYTHM 1 / MOTION 1, matching the wizard around it.
- Focal point: the question text while asking; the Stop button while recording.
- Whitespace separates the header row, the question, the answer and the navigation.
- One accent: the red recording state.
- Motif: the portal's own (purple primary, bordered cards).
- Design Read declared above.

## Block 4: Craftsmanship and Quality Locks (all "no")
- C-1 to C-5 PASS: reasons written above; every control works; nothing is template filler; states, themes, breakpoints and keyboard covered; no claims.
- R-05 PASS: no template layout. R-11 PASS: the system's radii. R-15 PASS: "Speak my answers", "Type my answers", "Fill in my brief". R-16 PASS: no buzzwords. R-20 / R-30 PASS: the portal's identity, no clone. R-21 PASS: the portal's existing toggle. R-29 PASS: no new colour.

## Addendum, 17 Nov: the "still empty" line and three reworded hints
- Copy: "Still empty: {fields}. Add them in the form below if your agent needs them." One sentence of fact and one instruction, no em dash, no buzzword, in en, ar and fr-CA. The three hints gained one clause each (address, a name, questions callers ask) and say what to give, not why.
- UI: one line of text inside the existing success alert, same type size and colour. No new control, colour, icon or motion, so the dials and the focal point are unchanged.
- States: shown only when a field is empty; absent for a full brief. Checked at 1280 px and 390 px in the browser runs; no sideways scroll in any locale.
