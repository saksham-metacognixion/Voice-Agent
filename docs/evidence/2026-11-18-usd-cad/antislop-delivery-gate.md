# antislop delivery gate: ADR 0049 UI and copy (mode: during)

Design Read: currency controls and notes inside existing settings, wallet and console screens, for
small-business owners and staff, in the portal's existing token-based language. Dials unchanged from
the screens they join: ENERGY 1 / RHYTHM 1 / MOTION 1. Direction: `docs/brand.md` and the `@portal/ui`
tokens; no new colour, typeface, icon, illustration or motion was added.

What was built: one select and one sentence in the pack selector (W7 and the wallet's Buy credits),
a conversion note, two alerts (currency unavailable, price changed), one field in Settings, a hint on
the auto top-up pack field; in the console a Currencies tab, a Change currency dialog and six settings
fields. Copy in en, ar and fr-CA.

| Block | Result | Evidence |
| --- | --- | --- |
| R-02 em dash | PASS | None in the new strings of the three catalogues or the console copy |
| R-03 mobile | PASS for the portal | 390 px: no horizontal overflow in the buy dialog and Settings (en, ar, fr-CA), `browser-qa-results.txt`. The console is a 768 px and up tool by its own rule |
| R-17, R-36, R-38 numbers and claims | PASS | Every figure shown is read from `GET /pricing` or `GET /admin/pricing/fx`: prices, the rate and its date. No rounding rule or rate is typed into copy |
| R-23 assets | PASS | None created |
| R-24, R-26 navigation and controls | PASS | Every new control acts: the selects save or reprice, Pay charges, Refresh asks the source, the console link goes to System, Settings |
| R-25 contrast | PASS | Existing tokens only (`text-muted-foreground`, `Alert` variants) |
| R-27 states | PASS | Loading (skeletons, Pay disabled while prices refetch), error (`ErrorState`, alerts), empty (no rate: "not available", console "No rate has been stored yet") |
| R-32, R-39 keyboard and semantics | PASS | Radix `Select` with a visible `<label>` through `Field`; opens with Enter, closes with Escape (browser pass) |
| R-34 themes | Not rechecked | No colour was added; the dark theme was not opened in this pass |
| R-35 verify by running | PASS for the portal, PARTIAL for the console | Portal: 24 recorded checks including a real payment. Console tab, dialog and settings fields: built, typechecked and linted, not clicked through |
| Purpose gate (R-01 to R-22) | PASS | No gradient, glow, badge, icon, shadow or animation added |
| Quality locks (R-05, R-11, R-15, R-16, R-29, R-30, R-31) | PASS | Existing components and radius; action labels say what they do ("Refresh now", "Change currency"); no buzzwords |

Not clean: R-34 was not rechecked and the console was not clicked through. Both are listed as owed.
