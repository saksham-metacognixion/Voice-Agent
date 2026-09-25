-- Menu upload for restaurant agents (25 Sep 2026). A knowledge source may carry a role:
-- `menu` is the restaurant's menu, one per agent. The partial unique index is the
-- "one menu" rule — a replace deletes the old row (or parks it in `deleting` while the
-- platform copy goes) before the new one is created, and two concurrent uploads collide
-- here instead of leaving two menus. Plain sources keep NULL and are untouched.
CREATE TYPE "knowledge_role" AS ENUM ('menu');

ALTER TABLE "knowledge_sources"
  ADD COLUMN "role" "knowledge_role";

CREATE UNIQUE INDEX "knowledge_sources_agent_role_idx"
  ON "knowledge_sources" ("agent_id", "role")
  WHERE "role" IS NOT NULL AND "status" <> 'deleting';
