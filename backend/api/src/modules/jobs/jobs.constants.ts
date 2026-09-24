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
 *   provisioning  D6: knowledge ingestion, number purchase/import and the §13.8
 *              activation workflow. Every job here is several voice-platform round trips
 *              (a KB ingest is ~12 s, a number purchase a few seconds) and must not sit
 *              in front of a `calls` write-behind, nor behind a slow LLM on `prompting`.
 *   scheduled  the §13.11 Job Schedulers, one process at a time
 */
export const QUEUES = {
  webhooks: 'webhooks',
  calls: 'calls',
  prompting: 'prompting',
  provisioning: 'provisioning',
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
  /** D6 W4: push one knowledge source to the platform and wait for ingestion. `jobId = ksync-<source id>[-<n>]`. */
  knowledgeSync: 'knowledge-sync',
  /** D6 §11: buy or import one number outside the wizard. `jobId = provnum-<number id>`. */
  provisionNumber: 'provision-number',
  /** D6 §13.8: publish → provision → bind → mark live → notify. `jobId = activate-<jobs.id>`. */
  activateAgent: 'activate-agent',
  /**
   * ADR 0011 §7 for one call someone is looking at: `GET /calls/:id` served an unsettled
   * row, so ask `get-call` now instead of waiting for the 5-minute schedule. `jobId =
   * recover-<call_id>`, delayed, freed when it settles — at most one per call per delay.
   */
  recoverCall: 'recover-call',
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
  /** Settles calls whose call_ended / call_analyzed the platform never delivered (CallRecoveryService, ADR 0011 §7). */
  callRecovery: 'call-recovery',
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
  /**
   * How long one tick may hold the per-schedule lock (D7). A tick that outlives its
   * interval meets the next one on another worker; the lock turns that into a logged
   * skip. Defaults to twice the interval for `every`, one hour for a cron.
   */
  lockTtlS?: number;
}

/**
 * §13.11, as of D7. `daily-digest` is **hourly** on purpose: every tick asks each
 * workspace whether it is past the digest hour in *its own* timezone and whether
 * yesterday's digest went out — one UTC midnight run would mail Kolkata at 05:30 and
 * Vancouver at 16:00 (DailyDigestService). `number-rental` is hourly so an anniversary
 * is charged within the hour, and so a workspace that tops up after going overdue is
 * charged the same day. `call-recovery` (every 5 min) asks the platform about calls whose
 * `call_ended` or `call_analyzed` never arrived and stores its answer as that webhook. `kb-sync` (automatic knowledge re-ingest) stays a skeleton — the
 * platform re-crawls URL sources itself and nothing in P1 needs the schedule yet.
 */
export const SCHEDULES: readonly ScheduleSpec[] = [
  { name: SCHEDULED_JOBS.runtimeCacheRefresh, every: 5 * 60_000, status: 'live' },
  { name: SCHEDULED_JOBS.webhookSweeper, every: 60_000, status: 'live' },
  { name: SCHEDULED_JOBS.jobSweeper, every: 60_000, status: 'live' },
  { name: SCHEDULED_JOBS.creditExpiry, pattern: '15 3 * * *', status: 'live' },
  { name: SCHEDULED_JOBS.numberRental, pattern: '5 * * * *', status: 'live', lockTtlS: 50 * 60 },
  { name: SCHEDULED_JOBS.lowBalanceAlerts, every: 15 * 60_000, status: 'live' },
  { name: SCHEDULED_JOBS.autoTopup, every: 15 * 60_000, status: 'live' },
  { name: SCHEDULED_JOBS.reconcileCalls, pattern: '30 2 * * *', status: 'live' },
  { name: SCHEDULED_JOBS.callRecovery, every: 5 * 60_000, status: 'live' },
  { name: SCHEDULED_JOBS.voiceCache, pattern: '0 5 * * *', status: 'live' },
  { name: SCHEDULED_JOBS.concurrencyMonitor, every: 5 * 60_000, status: 'live' },
  { name: SCHEDULED_JOBS.numberRelease, pattern: '0 6 * * *', status: 'live' },
  { name: SCHEDULED_JOBS.dailyDigest, pattern: '10 * * * *', status: 'live', lockTtlS: 50 * 60 },
  { name: SCHEDULED_JOBS.kbSync, pattern: '0 1 * * *', status: 'skeleton' },
];

/** The lock TTL for one tick of a schedule (see ScheduleSpec.lockTtlS). */
export function scheduleLockTtlS(spec: ScheduleSpec): number {
  if (spec.lockTtlS) return spec.lockTtlS;
  if (spec.every) return Math.max(60, Math.min(3_600, Math.round((spec.every * 2) / 1000)));
  return 3_600;
}

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

export interface RecoverCallJob {
  callId: string;
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

/** D6 W4. The row carries everything; the payload only names it. */
export interface KnowledgeSyncJob {
  sourceId: string;
  workspaceId: string;
  agentId: string;
  /** How many times the ingest poll re-enqueued itself; bounded by the worker. */
  poll?: number;
  /** `delete` removes the platform copy and the row; default is a sync. */
  purpose?: 'sync' | 'delete';
}

/** D6 §11: provision one `phone_numbers` row outside the activation workflow. */
export interface ProvisionNumberJob {
  numberId: string;
  workspaceId: string;
  /** Who asked, for the audit row. */
  userId: string | null;
}

/**
 * D6 §13.8. Like the prompting jobs, the `jobs` row is the state; the payload identifies
 * the work. `userId` and `role` rebuild the `WorkspaceContext` the publish step needs.
 */
export interface ActivationJob {
  jobId: string;
  workspaceId: string;
  agentId: string;
  userId: string | null;
  versionNo?: number;
}
