# templates

Versioned agent templates per spec §9.2, one JSON file per template id: `receptionist`, `appointment`,
`afterhours`, `lead_qual`, `faq_support`, `restaurant`, `custom`. Each carries brief prefill, conversation
steps, analysis fields, default rules, default tier, sample audio path and industry-specific example texts.

Files land on D5 alongside the `agents` and `prompting` modules. The `templates` table is seeded from
here; the admin console (SA6) edits and publishes new versions from P2.
