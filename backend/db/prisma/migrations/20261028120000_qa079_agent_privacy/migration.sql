-- QA-079 / QA-081 (D6 Data & privacy, spec p. 39): the workspace's PII-removal default for
-- new agents and the recording notice a recording agent says before its greeting. The
-- per-agent denoise / PII switches travel with the version in `agent_versions.settings_json`
-- and need no column.
ALTER TABLE "tenants"
  ADD COLUMN "pii_removal_default" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "recording_notice" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "recording_notice_text" TEXT;
