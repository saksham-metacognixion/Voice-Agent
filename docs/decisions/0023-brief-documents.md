# 0023 — Business documents in the brief: a menu or price list on W2, verbatim in the prompt

Date: 29 Sep 2026. Status: accepted. Builds on ADR 0012 (prompting pipeline, guardrails
appended in code), ADR 0013 (knowledge sources), ADR 0020 (the restaurant menu as a
knowledge role). Spec: §9.3–§9.4 (prompt, guardrails), §11 (knowledge), W2, D3.

## Context

A design partner building a restaurant agent on 29 Sep 2026 asked where to upload the
menu, on W2, while writing the brief. The answer was "on W4, two steps later, once you
have bought a Growth pack" — and for a dentist's price list or a salon's services sheet the
answer was "type it into the pricing box, 500 characters". Two things were wrong with that:

1. **The file was gated by plan.** A knowledge source needs the `knowledge_base` gate
   (§5.2: Starter includes none, the trial has none), because it costs a platform
   knowledge base, a sync job and a monthly allowance. But a menu is not a corpus to
   search; it is a page or two the agent should simply *know*. Gating the most-asked-about
   fact of a restaurant behind the second pack meant the first test call — the one that
   sells the product — could not answer "how much is the carbonara".
2. **The script's writer never saw it.** A knowledge source reaches the agent through
   platform retrieval at call time. The generation model only ever saw its *name*
   (`knowledgeSection()`), so the script could say "answer from the menu" but not
   "the menu has three pizzas and a lunch special". And nothing existed for the trial
   workspace in the screenshot, where the only place a price could live was `brief.pricing`.

## Decision

### 1. Documents are a brief field, not a knowledge source

`brief.documents` (`briefDocuments` in `@portal/schemas`): up to three documents, each
`{name, content_type, text, truncated}`, **15 000 characters in total**. They are part of
`agent_versions.brief_json`, so they save with the brief (the W2 autosave), version with it
(immutable once published, ADR 0012 §2), and are shown on W2 and the D3 Brief tab through
the shared `BriefFields`. No plan gate, no platform knowledge base, no sync job, no
allowance — which is exactly why a trial workspace can use it on the first screen.

The budget is characters, not files, because every character is in the prompt on every
call (§3). Three A4 pages of menu is ~6 000 characters; the cap is comfortable for a
menu, a price list or a services sheet and deliberately too small for a policy manual.
Anything bigger is still a W4 knowledge source, searched rather than read, gated as before.

### 2. Extraction is a stateless route

`POST /agents/:id/documents/extract {name, content_type, content_base64}` → `{name,
content_type, text, chars, truncated}`. PDF through `unpdf` (pdf.js without a canvas, so
the API's CommonJS build needs no native module), Word through `mammoth` raw text, and
text/Markdown/CSV as UTF-8. Both readers load on first use. The route stores **nothing**:
the portal puts the text into the brief and the autosave persists it like any other field,
so there is no second table, no orphaned bytes and no cleanup. The agent lookup is the only
database work and it closes before the parse — a 10 MB PDF is seconds of CPU and does not
belong inside `withWorkspace`.

A file with no text (a scan, a broken export) is `400 DOCUMENT_UNREADABLE`, its own code
because the portal branches on codes and the message has to tell the person to export the
file as text. Files are ≤ 10 MB (`BRIEF_DOCUMENT_MAX_FILE_BYTES`); PDF, Word, text,
Markdown, CSV and — added the same day, at Saksham's request — **photos** (JPEG, PNG,
WebP: `BRIEF_DOCUMENT_IMAGE_TYPES`).

**A photo is read by the generation model's vision** (`PromptProvider.transcribeImage`,
same `GENERATION_MODEL`, effort and thinking knobs as generation, one retry on a transient
failure). Build time only, never on a call — ADR 0009's rule holds. The instruction asks
for the text word for word in reading order and `NO_TEXT` for a picture with none, which
comes back as `DOCUMENT_UNREADABLE`; a refusal is the same, an outage is
`503 UPSTREAM_UNAVAILABLE`, a keyless box is `503 NOT_CONFIGURED`, and the SA12
`pause_generation` switch refuses a photo (`409 GENERATION_PAUSED`) but not a file. The
route therefore lives in `prompting` (`PromptingController`), not `agents`. The browser
re-encodes a photo to a JPEG of at most 2 000 px on the long side before upload
(`shrinkPhoto` in `brief-documents.tsx`, EXIF orientation applied): a 2.1 MB 3024×4032
PNG went up as 95 KB. Measured 29 Sep on the real model: a rotated, noisy two-column
menu photo transcribed in 2.9–3.5 s with every item and price right, accents included;
a photo of a blank wall answered `DOCUMENT_UNREADABLE` in 1.8 s. `ScriptedPromptProvider`
answers `transcribeImage` too, so the e2e suite drives the whole photo path.

**Fastify's body limit is raised to 32 MiB** in `main.ts`. It was the 1 MiB default,
which means a W4 knowledge file over ~750 KB — most PDF menus — had been answering 413
since D6. The two upload routes both carry base64 in JSON; nothing else comes close.

### 3. The text reaches the platform verbatim, in code, next to the guardrails

The generated script never carries a document's text. `runtimePrompt()` in
`modules/prompting/documents.ts` builds what the platform runs:

```
<editable script>

## Business documents (attached)
The business uploaded these. Answer from them word for word…
### Dinner menu
Margherita $14 …

## Platform rules (fixed)
- Never claim to be human …
```

It is applied at the one platform boundary, `AgentRetellService.llmSpec()`, so publish
and the draft sync (W5 test calls) agree, and it is idempotent like `applyGuardrails`.
The stored `prompt_text` has no documents block, the Advanced editor's `editable_prompt`
has none, the §9.5 lint's `prompt_too_long` (6 000 chars) counts the script alone, and a
version diff shows what the customer edited. A re-upload changes what the phone hears at
the next sync without a regenerate, and a document removed on the Brief tab is gone from
the next publish.

Why not let the model write the prices into the script: a retyped price is a second copy
that can differ from the first, and a model asked to keep 15 000 characters of menu in
its output would double the generation's latency, which is output length (ADR 0012).

### 4. The model is told about the documents and shown an excerpt

`documentsSection()` in the generation user turn names each document, shows its first
1 200 characters, says the full text is attached automatically under that heading, and
asks for the *behaviour*: answer items, prices and details from the documents word for
word, say when something is not in them, never invent. `briefForModel()` carries the
names only. The §9.6 feedback patch cannot touch `documents` (the structured-output
schema is closed and `mergeBriefPatch` skips the key) — they are the customer's files,
never the model's to rewrite.

### 5. The W2 menu upload of ADR 0020 stays

A restaurant on Growth or above may still hold a `role = menu` knowledge source on W4:
it is searched rather than read, survives a menu longer than the budget, and its rules
in `knowledgeSection()` are unchanged. The two are complementary, and a restaurant that
uploads the same menu in both places loses nothing but a little prompt length.

## Alternatives considered

- **Open the `menu` role to every industry and keep it a knowledge source.** Still gated
  by plan, still invisible to the script's writer, still a platform round trip per
  upload. It solves the label and not the two problems above.
- **A `documents` table with the file kept.** Nothing needs the bytes after extraction,
  and a second table means a second lifecycle (delete with the agent, anonymise with the
  workspace, cap per plan). The brief already has all of that.
- **Extract in the browser.** pdf.js runs there, but Word does not without a bundle the
  size of the portal, and one extractor on the server is one set of rules to test.
- **Classic OCR (Tesseract) for photos.** A native dependency on the Alpine image, and it
  reads a two-column menu line by line across both columns — prices land next to the
  wrong dish. The vision model keeps columns apart and costs one call per upload.
- **Sending the image to the platform's knowledge base.** It ingests documents, not
  pictures (ADR 0020), and the text would still not reach the script.

## Consequences

- `brief.documents` is on every `agentDetail` and `agentVersionDetail`; a brief without it
  parses (`default([])`), so no migration.
- New: `POST /agents/:id/documents/extract` (owner/admin/editor, `NOT_FOUND`,
  `BAD_REQUEST`, `DOCUMENT_UNREADABLE`, `VALIDATION_FAILED`, and for photos
  `GENERATION_PAUSED`, `UPSTREAM_UNAVAILABLE`, `NOT_CONFIGURED`); `BriefDocuments` in
  `src/components/wizard/brief-documents.tsx`, rendered by `BriefFields` on W2 and the D3
  Brief tab; `wizard.w2.documents.*` copy; `document_added` / `document_removed` events.
- `runtimePrompt()` replaces `applyGuardrails()` in `AgentRetellService.llmSpec()`; nothing
  else changed there. `documents.test.ts` pins the order, idempotency and that the editor
  never sees the block; `document-text.test.ts` runs a real PDF and a real .docx through
  the readers; `prompt-builder.test.ts` pins the excerpt and the names-only brief.
- Dependencies: `unpdf`, `mammoth` (api), `jszip` (dev, builds the test .docx). No new one for photos.
- **`parseBrief` repairs per field, never wipes the brief** (found by this QA, 29 Sep). It
  used to return an empty brief when *any* field failed. The dev worker had started 30 s
  before `@portal/schemas` was rebuilt with the image types, read one `image/jpeg`
  document as invalid, got `{}`, generated a script from nothing and stored it as v5 with
  an empty brief. The same happens in a deploy whose API is ahead of its worker, or after
  any tightening of a brief field. Now a bad `documents` entry is dropped alone, a bad
  field is dropped alone, `{}` only for input that is not an object; the generation
  worker refuses (`brief_incomplete`, "We could not read your brief just now…") a brief
  that is not generation-ready as *it* parses it, and `POST /generate` judges the
  repaired brief, so one unreadable document cannot block the agent. Regression tests in
  `brief.test.ts` and `prompting.e2e.test.ts`.
- Not done: a per-document "replace"; HEIC (iOS Safari converts on pick, desktop Chrome
  cannot decode it); showing the extracted text on W2 (the count and
  the "cut short" badge are what the customer sees — a read-only preview is a small
  follow-up if partners ask what the agent read).
