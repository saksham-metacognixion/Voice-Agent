/**
 * The `agent:{id}` SSE topic (§16): one place where every frame type is named, so the
 * portal and the backend cannot drift on a string.
 *
 * Frames are small on purpose. A client that missed one re-reads `GET /agents/:id` —
 * `events.ts` in `@portal/schemas` explains why the server never replays — so a frame
 * carries the identifiers needed to decide *whether* to re-read, not the resource itself.
 *
 * Authorisation needs no code here: `EventsService.publish(workspaceId, …)` writes to that
 * workspace's channel alone, and `GET /events` subscribes only to `ctx.workspaceId`'s.
 * Another workspace's agent frames are unreachable by construction, not by filtering.
 */
export const AgentEvents = {
  topic: (agentId: string) => `agent:${agentId}`,

  /** W1 — the agent row and its v1 draft exist. */
  created: 'created',
  /** W2/W3 autosave, or a D3 tab save. */
  draftUpdated: 'draft_updated',
  /** §13.5 Undo / "Restore as draft": the draft pointer moved, nothing was written. */
  draftSelected: 'draft_selected',
  /** The generation job was picked up; W2 shows its three-stage progress. */
  generationStarted: 'generation_started',
  /**
   * `{stage: 'writing'}` — the model's first token has arrived. The wait is almost all
   * the model streaming its answer (ADR 0012, 21 Sep), so this is the one honest point
   * at which W2's bar can move between "started" and "done".
   */
  generationProgress: 'generation_progress',
  /** §13.3: `{event: generated, version_no, brief_card, scenarios}`. */
  generated: 'generated',
  /** The job failed for good. `data.reason` is customer-safe; the detail is on the job. */
  generationFailed: 'generation_failed',
  /** §13.5: `{event: patched, version_no, changes[]}`. */
  patched: 'patched',
  /** Any other new row in `agent_versions` (a manual prompt save). */
  versionCreated: 'version_created',
  /** §13.6 — live, and numbers bound to `latest_published` pick it up on the next call. */
  published: 'published',
  paused: 'paused',
  resumed: 'resumed',
  deleted: 'deleted',
} as const;

export type AgentEventType = (typeof AgentEvents)[Exclude<keyof typeof AgentEvents, 'topic'>];
