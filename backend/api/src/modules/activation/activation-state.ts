import { ACTIVATION_STEPS, type ActivationStatus, type ActivationStep, type ActivationStepStatus, type ActivationView } from '@portal/schemas';

/*
 * The §13.8 workflow as data. Everything here is pure: the worker reads `steps_json`,
 * asks these functions what to do next and what the customer should see, and writes the
 * result back. Tests exercise the transitions without a queue or a database.
 */

export interface StepRecord {
  status: ActivationStepStatus;
  started_at?: string;
  finished_at?: string;
  /** Step-specific facts (version_no, number_id, e164, …). Never secrets. */
  [key: string]: unknown;
}

/** What `jobs.steps_json` holds for an activation. `agent_id` is what the one-active index keys on. */
export interface ActivationSteps {
  agent_id: string;
  version_no?: number;
  activation_status: ActivationStatus;
  /** The step in flight, or the one that failed. */
  activation_step: ActivationStep | null;
  attempt: number;
  max_attempts: number;
  steps: Partial<Record<ActivationStep, StepRecord>>;
  number_id?: string | null;
  e164?: string | null;
  forwarding_from?: string | null;
  forwarding_status?: string | null;
  customer_reason?: string;
  error_kind?: string;
  requested_by?: string | null;
  requested_at?: string;
  [key: string]: unknown;
}

export const ACTIVATION_MAX_ATTEMPTS = 3;

export function initialSteps(agentId: string, input: { versionNo?: number; requestedBy: string | null }): ActivationSteps {
  return {
    agent_id: agentId,
    version_no: input.versionNo,
    activation_status: 'pending',
    activation_step: null,
    attempt: 0,
    max_attempts: ACTIVATION_MAX_ATTEMPTS,
    steps: Object.fromEntries(ACTIVATION_STEPS.map((step) => [step, { status: 'pending' }])) as ActivationSteps['steps'],
    requested_by: input.requestedBy,
    requested_at: new Date().toISOString(),
  };
}

/** Reads back whatever a previous run left, tolerating an older or partial shape. */
export function parseSteps(value: unknown, agentId: string): ActivationSteps {
  const base = initialSteps(agentId, { requestedBy: null });
  if (!value || typeof value !== 'object') return base;
  const raw = value as Partial<ActivationSteps>;
  const steps = { ...base.steps };
  for (const step of ACTIVATION_STEPS) {
    const record = raw.steps?.[step];
    if (record && typeof record === 'object' && typeof record.status === 'string') steps[step] = record;
  }
  return {
    ...base,
    ...raw,
    agent_id: typeof raw.agent_id === 'string' ? raw.agent_id : agentId,
    activation_status: isStatus(raw.activation_status) ? raw.activation_status : base.activation_status,
    activation_step: isStep(raw.activation_step) ? raw.activation_step : null,
    attempt: typeof raw.attempt === 'number' ? raw.attempt : 0,
    max_attempts: typeof raw.max_attempts === 'number' ? raw.max_attempts : ACTIVATION_MAX_ATTEMPTS,
    steps,
  };
}

/** The first step that has not completed (or been skipped), in order. Null when all are done. */
export function nextStep(state: ActivationSteps): ActivationStep | null {
  for (const step of ACTIVATION_STEPS) {
    const status = state.steps[step]?.status ?? 'pending';
    if (status !== 'completed' && status !== 'skipped') return step;
  }
  return null;
}

const STATUS_OF_STEP: Record<ActivationStep, ActivationStatus> = {
  publish: 'publishing',
  provision: 'provisioning',
  bind: 'binding',
  mark_live: 'marking_live',
  notify: 'marking_live',
};

export function statusForStep(step: ActivationStep): ActivationStatus {
  return STATUS_OF_STEP[step];
}

/** Marks a step running and moves the workflow status with it. Returns a new object. */
export function beginStep(state: ActivationSteps, step: ActivationStep, now = new Date()): ActivationSteps {
  return {
    ...state,
    activation_status: statusForStep(step),
    activation_step: step,
    steps: { ...state.steps, [step]: { ...(state.steps[step] ?? {}), status: 'running', started_at: state.steps[step]?.started_at ?? now.toISOString() } },
  };
}

export function completeStep(state: ActivationSteps, step: ActivationStep, facts: Record<string, unknown> = {}, now = new Date()): ActivationSteps {
  return {
    ...state,
    steps: { ...state.steps, [step]: { ...(state.steps[step] ?? {}), ...facts, status: 'completed', finished_at: now.toISOString() } },
  };
}

export function skipStep(state: ActivationSteps, step: ActivationStep, reason: string, now = new Date()): ActivationSteps {
  return {
    ...state,
    steps: { ...state.steps, [step]: { ...(state.steps[step] ?? {}), status: 'skipped', reason, finished_at: now.toISOString() } },
  };
}

/** A step failed. `final` means the job is over: the workflow reads `failed`; otherwise it stays on the step for the retry. */
export function failStep(
  state: ActivationSteps,
  step: ActivationStep,
  failure: { kind: string; detail: string; customerReason: string },
  final: boolean,
  now = new Date(),
): ActivationSteps {
  return {
    ...state,
    activation_status: final ? 'failed' : statusForStep(step),
    activation_step: step,
    error_kind: failure.kind,
    customer_reason: failure.customerReason,
    steps: {
      ...state.steps,
      [step]: { ...(state.steps[step] ?? {}), status: final ? 'failed' : 'pending', last_error: failure.detail.slice(0, 500), failed_at: now.toISOString() },
    },
  };
}

export function markLive(state: ActivationSteps): ActivationSteps {
  return { ...state, activation_status: 'live', activation_step: null };
}

/** Whole steps completed or skipped, as a percentage. `live` is always 100. */
export function progressOf(state: ActivationSteps): number {
  if (state.activation_status === 'live') return 100;
  const done = ACTIVATION_STEPS.filter((s) => {
    const status = state.steps[s]?.status;
    return status === 'completed' || status === 'skipped';
  }).length;
  return Math.round((done / ACTIVATION_STEPS.length) * 100);
}

/**
 * What the customer sees — on `GET /agents/:id/activation` and in every SSE frame.
 * Built field by field from the state: provider ids, `last_error` and the diagnostic
 * detail never leave the server.
 */
export function toView(state: ActivationSteps, job: { id: string; status: string; createdAt: Date; updatedAt: Date }): ActivationView {
  const failed = state.activation_status === 'failed' || job.status === 'failed';
  return {
    activation_id: job.id,
    agent_id: state.agent_id,
    status: failed ? 'failed' : state.activation_status,
    step: state.activation_step,
    progress: progressOf(state),
    attempt: state.attempt,
    max_attempts: state.max_attempts,
    steps: ACTIVATION_STEPS.map((step) => ({
      step,
      status: state.steps[step]?.status ?? 'pending',
      started_at: isoOrNull(state.steps[step]?.started_at),
      finished_at: isoOrNull(state.steps[step]?.finished_at),
    })),
    number_id: typeof state.number_id === 'string' ? state.number_id : null,
    e164: typeof state.e164 === 'string' ? state.e164 : null,
    forwarding:
      typeof state.forwarding_from === 'string'
        ? { from: state.forwarding_from, status: (state.forwarding_status as 'waiting_for_customer' | 'ready' | 'failed') ?? 'waiting_for_customer' }
        : null,
    error: failed ? (state.customer_reason ?? GENERIC_ACTIVATION_FAILURE) : null,
    created_at: job.createdAt.toISOString(),
    updated_at: job.updatedAt.toISOString(),
  };
}

export const GENERIC_ACTIVATION_FAILURE = 'We could not put your agent on the phone. Nothing was charged for the number; try again or contact support.';

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isStatus(value: unknown): value is ActivationStatus {
  return typeof value === 'string' && ['pending', 'publishing', 'provisioning', 'binding', 'marking_live', 'live', 'failed'].includes(value);
}

function isStep(value: unknown): value is ActivationStep {
  return typeof value === 'string' && (ACTIVATION_STEPS as readonly string[]).includes(value);
}
