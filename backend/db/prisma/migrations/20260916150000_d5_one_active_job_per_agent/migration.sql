-- ---------------------------------------------------------------------------
-- 5. One live job per (agent, type) — the duplicate-generation guard (§13.3).
--
-- W2 shows a ten-second progress bar, and an impatient second click lands on the same
-- route. The service answers that with the in-flight job's id, but a check-then-create
-- is a race: two requests both find nothing and both start a generation, and the customer
-- pays for two answers and gets two versions.
--
-- This index makes the check atomic. `steps_json->>'agent_id'` is what the job is about,
-- and the predicate limits the constraint to jobs that have not finished, so a second
-- generation *after* the first completes is unaffected. A job with no agent_id — a
-- workspace-wide export, say — yields NULL, and NULLs are distinct, so it is unconstrained.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_one_active_per_target_idx"
  ON "jobs" ((steps_json->>'agent_id'), "type")
  WHERE status IN ('queued', 'running');

COMMENT ON INDEX "jobs_one_active_per_target_idx" IS
  'One queued/running job per (agent, type) — the §13.3 duplicate-generation guard.';
