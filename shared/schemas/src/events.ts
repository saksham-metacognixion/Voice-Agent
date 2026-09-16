import { z } from 'zod';
import { isoDateTime } from './common.js';
import { sseTopic } from './enums.js';

/**
 * One frame on GET /events (§16). `topic` is the SSE `event:` name so the client can
 * `addEventListener('wallet', …)`; `type` says what happened on that topic.
 *
 *   wallet            ledger          {delta, balance_after, reason, ref_id}
 *   call:{id}         registered | in_progress | ended | analyzed | missed
 *   agent:{id}        (D5) generation and publish progress
 *   activation:{id}   (D8) number provisioning progress
 *
 * `id` is unique per frame so a client that reconnects with Last-Event-ID can drop what it
 * already saw; the server does not replay, so a missed frame is recovered by re-reading
 * the resource (`GET /wallet`, `GET /calls/:id`), which is why every frame is small.
 */
export const sseEvent = z.object({
  id: z.string().min(1),
  topic: sseTopic,
  type: z.string().min(1),
  ts: isoDateTime,
  data: z.unknown(),
});
export type SseEvent = z.infer<typeof sseEvent>;

/** GET /events?topics=wallet,call:abc — omitted means every topic of the workspace. */
export const eventsQuery = z.object({
  topics: z
    .string()
    .transform((s) => s.split(',').map((t) => t.trim()).filter(Boolean))
    .pipe(z.array(sseTopic).max(50))
    .optional(),
});
export type EventsQuery = z.infer<typeof eventsQuery>;
