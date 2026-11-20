import { hostname } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { Injectable, Logger } from '@nestjs/common';
import { RedisCache, redisKeys } from '../redis';

/** How often the beacon is refreshed, and how long it is believed. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TTL_S = 120;
/** Where the compose healthcheck looks (the worker exposes no port). */
export const DEFAULT_HEARTBEAT_FILE = '/tmp/worker.heartbeat';

export interface WorkerHeartbeatRecord {
  at: string;
  pid: number;
  host: string;
  env: string;
  /** Job schedulers present after registration, so `/health/ready` can say the §13.11 table is wired. */
  schedulers: number;
  queues: string[];
}

/**
 * D7: the worker's liveness beacon. Two sinks for two readers —
 *
 *   `worker:heartbeat` in Redis, read by `GET /health/ready` on the API, so one probe on
 *   `api.<domain>` also says whether the queues are being drained;
 *   a file (`WORKER_HEARTBEAT_FILE`), read by the compose `healthcheck` of the worker
 *   service, which has no port to probe.
 *
 * Never throws: a beacon that cannot be written is a warning, and `/health/ready` reports
 * the worker as unseen.
 */
@Injectable()
export class WorkerHeartbeat {
  private readonly log = new Logger(WorkerHeartbeat.name);
  private timer: NodeJS.Timeout | undefined;
  private record: WorkerHeartbeatRecord | undefined;

  constructor(private readonly cache: RedisCache) {}

  start(input: { env: string; schedulers: number; queues: string[] }, intervalMs = HEARTBEAT_INTERVAL_MS): void {
    this.record = { at: new Date().toISOString(), pid: process.pid, host: hostname(), env: input.env, schedulers: input.schedulers, queues: input.queues };
    void this.beat();
    this.timer = setInterval(() => void this.beat(), intervalMs);
    this.timer.unref();
  }

  async beat(): Promise<void> {
    if (!this.record) return;
    this.record = { ...this.record, at: new Date().toISOString() };
    const ok = await this.cache.setJson(redisKeys.workerHeartbeat, this.record, HEARTBEAT_TTL_S);
    if (!ok) this.log.warn('heartbeat: Redis did not take the beacon');
    const file = process.env.WORKER_HEARTBEAT_FILE ?? DEFAULT_HEARTBEAT_FILE;
    await writeFile(file, `${this.record.at}\n`).catch((error: unknown) => this.log.warn(`heartbeat: cannot write ${file}: ${String(error)}`));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
