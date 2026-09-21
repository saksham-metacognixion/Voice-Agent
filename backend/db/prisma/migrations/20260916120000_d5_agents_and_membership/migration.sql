-- ===========================================================================
-- D5 — workspaces, members, agents and prompting.
--
-- Four things, all of them constraints rather than columns-for-their-own-sake.
-- Everything here is hand-written and `prisma migrate dev` will not regenerate it;
-- carry it forward verbatim if the migrations are ever squashed (ADR 0006).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Agents are soft-deleted (§17, D5 requirement 16).
--
-- An agent cannot be removed from the database: `calls` references it and calls are
-- billing history. `agents.deleted_at` is therefore the delete, and every customer read
-- filters on it. The Retell objects *are* destroyed, so a deleted agent can never answer.
-- ---------------------------------------------------------------------------
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp(3);

COMMENT ON COLUMN "agents"."deleted_at" IS
  'Soft delete (§17). Set by DELETE /agents/:id; the row stays because calls reference it.';

-- The D3 list and every lookup are "live agents of this workspace".
CREATE INDEX IF NOT EXISTS "agents_tenant_live_idx"
  ON "agents" ("tenant_id", "status")
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. agent_versions are immutable (§9.9), enforced in the database.
--
-- "Every generation or edit creates a new immutable row. Nothing is edited in place."
-- With one carve-out the spec asks for in the same breath: W2 autosaves the brief
-- ("PATCH /agents/:id/draft {brief_json} — writes to current draft version, no LLM
-- call"), so the row that is *still being written* has to be writable. The line between
-- the two is drawn here rather than in a service:
--
--   * a version that has been published is frozen, forever;
--   * a version that has a successor is frozen — history never changes retroactively,
--     so re-selecting an old version as the draft (§13.5 Undo) cannot reopen it;
--   * the newest, unpublished version is the draft, and its brief and prompt may change
--     until either of the above happens.
--
-- Four columns stay writable in every state because they record what happened *to* a
-- version rather than what it says: published_at, retell_agent_version, lint_json and
-- stack_version. Identity — agent_id, version_no, source, created_at — never moves.
--
-- Unlike the three append-only tables this is not a REVOKE: the row must stay updatable
-- for those columns, so only a trigger can express the rule.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.reject_agent_version_rewrite() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A version is deleted only with its agent, and an agent is never hard-deleted while
    -- it has history. A cascade from `tenants` (a §17 erasure) is the one legitimate
    -- path, and that runs as the owner, which this trigger deliberately still blocks —
    -- erasure is an anonymisation job, not a DELETE (CLAUDE.md, append-only tables).
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
      NEW."changes_json", NEW."feedback_text", NEW."created_by")
     IS DISTINCT FROM
     (OLD."brief_json", OLD."prompt_text", OLD."greeting", OLD."closing",
      OLD."analysis_schema_json", OLD."brief_card_json", OLD."scenarios_json",
      OLD."changes_json", OLD."feedback_text", OLD."created_by")
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

DROP TRIGGER IF EXISTS agent_versions_immutable ON "agent_versions";
CREATE TRIGGER agent_versions_immutable
  BEFORE UPDATE OR DELETE ON "agent_versions"
  FOR EACH ROW EXECUTE FUNCTION app.reject_agent_version_rewrite();

-- ---------------------------------------------------------------------------
-- 2b. A publish lease, so two publishes of one agent cannot interleave (§13.6).
--
-- Publishing calls Retell four times and then writes. It cannot run inside a transaction
-- — that would hold a pooled connection across the network, which is the one thing
-- CLAUDE.md forbids — so the mutual exclusion has to outlive the transaction. This column
-- is that lock: a conditional UPDATE claims it, the publish runs, and a `finally` clears
-- it. The claim is a lease rather than a flag, so a worker that dies mid-publish does not
-- leave the agent unpublishable forever; the next attempt takes over after two minutes,
-- and every Retell step it repeats is idempotent.
--
-- A Redis key would have been the obvious choice and is the wrong one: Redis is allowed
-- to be down (ADR 0003 §12), and "Redis is down" must not read as "someone else is
-- publishing" and block every customer's publish.
-- ---------------------------------------------------------------------------
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "publishing_since" timestamp(3);

COMMENT ON COLUMN "agents"."publishing_since" IS
  'Publish lease (§13.6). Claimed by a conditional UPDATE; expires after 2 minutes.';

-- ---------------------------------------------------------------------------
-- 3. Exactly one owner per workspace (§6.1).
--
-- The sentence is in the spec; this is the only thing that makes it true. Transfer of
-- ownership demotes and then promotes inside one transaction, so the index is never
-- violated in the middle; two concurrent transfers make the second one fail here rather
-- than leave a workspace with two owners.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_one_owner_idx"
  ON "memberships" ("tenant_id")
  WHERE role = 'owner';

COMMENT ON INDEX "memberships_one_owner_idx" IS
  'Exactly one owner per workspace (§6.1). Transfer demotes before it promotes.';

-- ---------------------------------------------------------------------------
-- 4. One pending invite per (workspace, email) (A8).
--
-- Re-inviting someone who has not accepted yet should re-send the existing invite, not
-- stack a second row with a second live token. Accepted invites are excluded, so an
-- ex-member can be invited again.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "invites_pending_email_idx"
  ON "invites" ("tenant_id", lower("email"))
  WHERE accepted_at IS NULL;

COMMENT ON INDEX "invites_pending_email_idx" IS
  'One live invite per email per workspace (A8). A re-invite replaces the old token.';
