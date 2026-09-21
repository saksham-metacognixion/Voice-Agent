-- ===========================================================================
-- D5 review fixes (17 Sep 2026) — agent settings travel with the version, and the
-- immutability trigger stops fighting the `created_by` foreign key.
--
-- Hand-written; `prisma migrate dev` will not regenerate it (ADR 0006). Both changes
-- amend 20260916120000_d5_agents_and_membership §2 and are recorded in ADR 0012
-- ("Amendments").
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. `agent_versions.settings_json` — tier, voice, languages, duration ceiling,
--    recording (`agentSettings` in @portal/schemas).
--
-- Before this column the D3 Voice tab wrote `tier`, `voice_id` and `max_call_duration_s`
-- straight onto `agents`, and `agents.tier` is what a call is billed at (`calls.rate`)
-- and what `num:{e164}` carries. A draft edit therefore re-priced a live agent while
-- Retell kept running the old stack until the next publish. The settings are content:
-- they belong to the version, are frozen with it, and reach `agents` only through a
-- publish — which is also the moment the runtime cache is refreshed.
--
-- NULL means "an older row": the services fall back to the agent's columns, so nothing
-- written before this migration becomes unreadable.
-- ---------------------------------------------------------------------------
ALTER TABLE "agent_versions" ADD COLUMN IF NOT EXISTS "settings_json" jsonb;

COMMENT ON COLUMN "agent_versions"."settings_json" IS
  'Tier, voice, languages, max duration, recording for this version. Copied onto agents by publish; agents.* is the live copy.';

-- ---------------------------------------------------------------------------
-- 2. The immutability trigger, with two changes to the frozen tuple.
--
--   + settings_json   is content and freezes with the rest.
--   − created_by      records *who*, not *what*. Its foreign key is ON DELETE SET NULL,
--                     and with the column in the frozen tuple that FK action fired the
--                     trigger and every `DELETE FROM users` failed as soon as the user had
--                     authored a published or overtaken version. It joins published_at,
--                     retell_agent_version, lint_json and stack_version as bookkeeping.
--
-- Everything else is unchanged from 20260916120000 §2: published or overtaken versions
-- are frozen, identity never moves, rows are never deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.reject_agent_version_rewrite() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'version_immutable: agent_versions rows are never deleted'
      USING ERRCODE = '42501', HINT = 'Soft-delete the agent instead (agents.deleted_at).';
  END IF;

  -- Identity never moves, in any state.
  IF (NEW."agent_id", NEW."version_no", NEW."source", NEW."created_at")
     IS DISTINCT FROM
     (OLD."agent_id", OLD."version_no", OLD."source", OLD."created_at")
  THEN
    RAISE EXCEPTION 'version_immutable: a version cannot be renumbered or moved (§9.9)'
      USING ERRCODE = '42501', HINT = 'Create a new version instead.';
  END IF;

  -- Content: only the newest, unpublished version of its agent may change.
  IF (NEW."brief_json", NEW."prompt_text", NEW."greeting", NEW."closing",
      NEW."analysis_schema_json", NEW."brief_card_json", NEW."scenarios_json",
      NEW."changes_json", NEW."feedback_text", NEW."settings_json")
     IS DISTINCT FROM
     (OLD."brief_json", OLD."prompt_text", OLD."greeting", OLD."closing",
      OLD."analysis_schema_json", OLD."brief_card_json", OLD."scenarios_json",
      OLD."changes_json", OLD."feedback_text", OLD."settings_json")
  THEN
    IF OLD."published_at" IS NOT NULL THEN
      RAISE EXCEPTION 'version_immutable: a published version cannot be rewritten (§9.9)'
        USING ERRCODE = '42501', HINT = 'Publishing froze this version. Create a new one.';
    END IF;

    IF EXISTS (
      SELECT 1 FROM "agent_versions" v
       WHERE v."agent_id" = OLD."agent_id" AND v."version_no" > OLD."version_no"
    ) THEN
      RAISE EXCEPTION 'version_immutable: version % is behind the draft and cannot be rewritten (§9.9)', OLD."version_no"
        USING ERRCODE = '42501', HINT = 'Edits fork a new version from this one.';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- The trigger itself is unchanged; recreated so the function binding is explicit.
DROP TRIGGER IF EXISTS agent_versions_immutable ON "agent_versions";
CREATE TRIGGER agent_versions_immutable
  BEFORE UPDATE OR DELETE ON "agent_versions"
  FOR EACH ROW EXECUTE FUNCTION app.reject_agent_version_rewrite();
