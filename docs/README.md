# docs

| Path                               | What it is                                                              |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `Voice Agent Project.pdf`          | Portal spec v0.2, 10 Sep 2026, 57 pages. The primary source of truth.   |
| `Admin dashboard Voice agent .pdf` | Admin console spec v0.1, 10 Sep 2026, 23 pages. Companion to the above. |
| `decisions/`                       | Architecture decision records.                                          |
| `spec-extract/`                    | Grep-able text pulled from the PDFs, with a page-to-section index.      |
| `plan/`                            | Delivery schedule, ClickUp task board, status message.                  |
| `tools/pdfdump.swift`              | Renders the PDFs to text and PNG using PDFKit. macOS only.              |

## Reading the specs

The PDFs were exported with the body copy as vector outlines, so a text extractor recovers only the
monospaced spans. That is still the useful half for a developer: API routes, table names, column names,
event names, Redis keys and enum values all survive in `spec-extract/`. Prose, wireframes and tables have
to be read from the PDF, or rendered to images.

To render every page to PNG:

```bash
swiftc -O -o /tmp/pdfdump docs/tools/pdfdump.swift
/tmp/pdfdump "docs/Voice Agent Project.pdf" /tmp/portal 2.0
/tmp/pdfdump "docs/Admin dashboard Voice agent .pdf" /tmp/admin 2.0
```

The second argument is the output directory, the third is the scale factor. Renders are large, roughly
26 MB for both specs, and are deliberately not committed.

## Citing the spec

Use `§13.9` for the portal spec and `admin §5.2` for the admin spec, in commit messages, PR descriptions
and code comments. The page index at the top of each `spec-extract/*.txt` maps sections to page numbers.
