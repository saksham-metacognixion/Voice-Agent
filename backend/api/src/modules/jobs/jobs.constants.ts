import type { AgentTier, DeclineReason } from '@portal/schemas';

/**
 * The BullMQ queues (architecture §12). Four, split by what a stall in one must not
 * hold up:
 *
 *   webhooks   provider events after they are stored in webhook_events — Retell call
 *              lifecycle (the money path), Stripe, and the Auth0 user.created upsert
 *   calls      write-behind from the inbound hot path and cache warm-ups; small jobs
 *              that keep Postgres off the 300 ms path (§13.9)
 *   prompting  brief → prompt generation and §9.6 feedback patches (D5). Its own queue
 *              because a job here is an LLM round trip — seconds, not milliseconds — and
 *              a slow model must never delay a `calls` write-behind or a webhook that
 *              moves credits. Concurrency is low for the same reason the timeout is
 *              tight: the ≤ 10 s p95 is measured from enqueue, so queue depth is latency.
 *   scheduled  the §13.11 Job Schedulers, one process at a time
 */
export const QUEUES = {
  webhooks: 'webhooks',
  calls: 'calls',
  prompting: 'prompting',
  scheduled: 'scheduled',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const JOBS = {
  /** Process one stored webhook_events row. `jobId = wh-<row id>`. */
  processWebhook: 'process-webhook',
  /** The `calls` row for an inbound authorisation, allowed or declined. `jobId = inbound-<call_id>`. */
  inboundDecision: 'inbound-decision',
  /** Fill `bal:{ws}` / `caps:{ws}` after the hot path saw a miss. `jobId = warm-<ws>`. */
  warmWorkspace: 'warm-workspace',
  /** Rebuild `num:{e164}` after the hot path saw a miss. `jobId = refresh-number-<e164>`. */
  refreshNumber: 'refresh-number',
  /** §13.3 brief → prompt. `jobId = gen-<jobs.id>`, so a retry is the same job row. */
  generateAgent: 'generate-agent',
  /** §13.5 feedback patch. `jobId = patch-<jobs.id>`. */
  patchAgent: 'patch-agent',
} as const;

/** §13.11 Job Schedulers. Registered idempotently on worker boot (architecture §12). */
export const SCHEDULED_JOBS = {
  runtimeCacheRefresh: 'runtime-cache-refresh',
  webhookSweeper: 'webhook-sweeper',
  /** Writes off `jobs` rows left queued/running by a dead worker (JobRecordsService.reconcileStale). */
  jobSweeper: 'job-sweeper',
  creditExpiry: 'credit-expiry',
  numberRental: 'number-rental',
  lowBalanceAlerts: 'low-balance-alerts',
  autoTopup: 'auto-topup',
  reconcileCalls: 'reconcile-calls',
  voiceCache: 'voice-cache',
  concurrencyMonitor: 'concurrency-monitor',
  numberRelease: 'number-release',
  dailyDigest: 'daily-digest',
  kbSync: 'kb-sync',
} as const;
export type ScheduledJobName = (typeof SCHEDULED_JOBS)[keyof typeof SCHEDULED_JOBS];

export interface ScheduleSpec {
  name: ScheduledJobName;
  /** Interval in ms, or a cron pattern. One of the two. */
  every?: number;
  pattern?: string;
  /** What the job does today. Skeleton entries log and return until their day lands. */
  status: 'live' | 'skeleton';
}

export const SCHEDULES: readonly ScheduleSpec[] = [
  { name: SCHEDULED_JOBS.runtimeCacheRefresh, every: 5 * 60_000, status: 'live' },
  { name: SCHEDULED_JOBS.webhookSweeper, every: 60_000, status: 'live' },
  { name: SCHEDULED_JOBS.jobSweeper, every: 60_000, status: 'live' },
  { name: SCHEDULED_JOBS.creditExpiry, pattern: '15 3 * * *', status: 'live' },
  { name: SCHEDULED_JOBS.numberRental, pattern: '0 4 * * *', status: 'skeleton' },
  { name: SCHEDULED_JOBS.lowBalanceAlerts, every: 15 * 60_000, status: 'skeleton' },
  { name: SCHEDULED_JOBS.autoTopup, every: 15 * 60_000, status: 'skeleton' },
  { name: SCHEDULED_JOBS.reconcileCalls, pattern: '30 2 * * *', status: 'skeleton' },
  { name: SCHEDULED_JOBS.voiceCache, pattern: '0 5 * * *', status: 'live' },
  { name: SCHEDULED_JOBS.concurrencyMonitor, every: 60_000, status: 'skeleton' },
  { name: SCHEDULED_JOBS.numberRelease, pattern: '0 6 * * *', status: 'skeleton' },
  { name: SCHEDULED_JOBS.dailyDigest, pattern: '0 12 * * *', status: 'skeleton' },
  { name: SCHEDULED_JOBS.kbSync, pattern: '0 1 * * *', status: 'skeleton' },
];

export interface ProcessWebhookJob {
  eventId: string;
  provider: 'retell' | 'stripe' | 'auth';
}

/** Everything the write-behind needs to write the `calls` row without touching Redis again. */
export interface InboundDecisionJob {
  /** Retell's call_id from the inbound webhook, or `dec_<uuid>` when it carried none. */
  callId: string;
  workspaceId: string;
  numberId: string | null;
  agentId: string | null;
  tier: AgentTier;
  fromNumber: string | null;
  toNumber: string | null;
  /** Unix ms from `event_timestamp`, else the time we answered. */
  eventTimestamp: number;
  decision: 'allow' | 'decline';
  declineReason: DeclineReason | null;
  /** Captured at authorisation (§14.2). Null when the pricing snapshot was not in Redis. */
  rate: number | null;
  configVersion: number | null;
  maxCallDurationMs: number | null;
  reservedCredits: number;
}

export interface WarmWorkspaceJob {
  workspaceId: string;
}

export interface RefreshNumberJob {
  e164: string;
}

/**
 * §13.3 / §13.5. Everything the worker needs is on the `jobs` row it names; the payload
 * carries only what identifies the work, so a job that sat in the queue through a draft
 * edit still reads the brief as it is *now* rather than as it was when the button was
 * pressed.
 */
export interface PromptingJob {
  /** `jobs.id` — the row the client polls with GET /jobs/:id and the BullMQ id's stem. */
  jobId: string;
  workspaceId: string;
  agentId: string;
  /** Who pressed the button, for `agent_versions.created_by` and the audit row. */
  userId: string | null;
  mode: 'generate' | 'regenerate' | 'feedback';
  /** §9.6 only: the free text and the version it was written against. */
  feedbackText?: string;
  baseVersionNo?: number;
}
