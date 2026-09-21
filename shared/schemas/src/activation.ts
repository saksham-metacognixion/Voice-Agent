import { z } from 'zod';
import { isoDateTime, uuid } from './common.js';
import { forwardingStatus } from './numbers.js';

/*
 * §13.8 Activation — the durable workflow between "paid" and "live":
 *
 *     publish → provision → bind → mark_live → notify
 *
 * State is one `jobs` row (type `activate-agent`), its `steps_json` holding one entry per
 * step, and the SSE topic `activation:{job_id}`. The frontend only ever sees the shapes
 * below; provider identifiers and error detail stay on the server.
 */

export const activationStep = z.enum(['publish', 'provision', 'bind', 'mark_live', 'notify']);
export type ActivationStep = z.infer<typeof activationStep>;
export const ACTIVATION_STEPS = activationStep.options;

export const activationStepStatus = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);
export type ActivationStepStatus = z.infer<typeof activationStepStatus>;

/** The workflow's own state, distinct from the job row's queued/running/succeeded/failed. */
export const activationStatus = z.enum(['pending', 'publishing', 'provisioning', 'binding', 'marking_live', 'live', 'failed']);
export type ActivationStatus = z.infer<typeof activationStatus>;

/** POST /agents/:id/activate. Everything else comes from the agent's pending phone plan. */
export const activateRequest = z.object({
  /** Publish this version; default the draft. */
  version_no: z.number().int().positive().optional(),
});
export type ActivateRequest = z.infer<typeof activateRequest>;

export const activationStepView = z.object({
  step: activationStep,
  status: activationStepStatus,
  started_at: isoDateTime.nullable(),
  finished_at: isoDateTime.nullable(),
});

/** GET /agents/:id/activation and the `data` of every `activation:{id}` frame. */
export const activationView = z.object({
  activation_id: uuid,
  agent_id: uuid,
  status: activationStatus,
  /** The step in flight, or the one that failed. */
  step: activationStep.nullable(),
  /** 0–100, derived from completed steps. */
  progress: z.number().int().min(0).max(100),
  attempt: z.number().int().min(0),
  max_attempts: z.number().int().min(1),
  steps: z.array(activationStepView),
  number_id: uuid.nullable(),
  e164: z.string().nullable(),
  forwarding: z.object({ from: z.string(), status: forwardingStatus }).nullable(),
  /** Customer-safe, only when `status = failed`. */
  error: z.string().nullable(),
  created_at: isoDateTime,
  updated_at: isoDateTime,
});
export type ActivationView = z.infer<typeof activationView>;

/** Frame types on `activation:{id}`. */
export const ActivationEvents = {
  topic: (activationId: string) => `activation:${activationId}`,
  started: 'started',
  /** One per state change: `data.status` moved. */
  progress: 'progress',
  live: 'live',
  failed: 'failed',
} as const;
