import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb } from '@portal/db';
import type {
  AdminConcurrencyResponse,
  AdminProvisioningJob,
  AdminProvisioningQuery,
  Page,
  PhoneNumberStatus,
  WorkspaceCaps,
} from '@portal/schemas';
import { cursorArgs, toPage } from '../../common/pagination';
// The pure step-machine mapping only — no Nest module of `activation` is imported, so
// the module graph still ends at `activation` (CLAUDE.md: nothing depends on it).
import { parseSteps, toView } from '../activation/activation-state';
import { concurrencyAlertPct, parseActiveHash, platformConcurrencyLimit } from '../calls';
import { PlatformConfigService } from '../config';
import { JOBS, queueOfJobType } from '../jobs';
import { REDIS, RedisCache, type RedisLike, redisKeys, workspaceOfActiveKey } from '../redis';
import { record } from './admin.helpers';

/** The `jobs` rows SA7 calls "the provisioning queue": every platform-facing step machine. */
export const PROVISIONING_JOB_TYPES = [
  JOBS.activateAgent,
  JOBS.provisionNumber,
  JOBS.knowledgeSync,
] as const;

const WITH = { tenant: { select: { id: true, name: true } } } satisfies Prisma.JobInclude;
type Row = Prisma.JobGetPayload<{ include: typeof WITH }>;

/**
 * SA7 (admin §4, D13): the provisioning queue and live concurrency, read the way the
 * system itself reads them — the activation view from the same `steps_json` mapping the
 * customer's W7 sees, live calls from the same `active:{ws}` hashes the §13.9 inbound
 * checks reserve into, caps from the same `caps:{ws}`. Redis not answering is reported
 * as `live: null` / `complete: false`, never as zero calls (ADR 0014 §7).
 */
@Injectable()
export class AdminOperationsService {
  private readonly log = new Logger(AdminOperationsService.name);

  constructor(
    private readonly cache: RedisCache,
    @Inject(REDIS) private readonly redis: RedisLike,
    private readonly config: PlatformConfigService,
  ) {}

  async provisioning(query: AdminProvisioningQuery): Promise<Page<AdminProvisioningJob>> {
    const where: Prisma.JobWhereInput = { type: { in: [...PROVISIONING_JOB_TYPES] } };
    if (query.status) where.status = query.status;
    if (query.tenant_id) where.tenantId = query.tenant_id;
    const [rows, total] = await Promise.all([
      adminDb.job.findMany({
        where,
        include: WITH,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...cursorArgs(query),
      }),
      adminDb.job.count({ where }),
    ]);
    const page = toPage(rows, query);

    const agentIds = new Set<string>();
    const numberIds = new Set<string>();
    for (const r of page.items) {
      const steps = record(r.stepsJson);
      if (typeof steps.agent_id === 'string') agentIds.add(steps.agent_id);
      if (typeof steps.number_id === 'string') numberIds.add(steps.number_id);
    }
    const [agents, numbers] = await Promise.all([
      agentIds.size
        ? adminDb.agent.findMany({
            where: { id: { in: [...agentIds] } },
            select: { id: true, name: true },
          })
        : [],
      numberIds.size
        ? adminDb.phoneNumber.findMany({
            where: { id: { in: [...numberIds] } },
            select: { id: true, e164: true, status: true },
          })
        : [],
    ]);
    const agentById = new Map(agents.map((a) => [a.id, a]));
    const numberById = new Map(numbers.map((n) => [n.id, n]));

    return {
      ...page,
      total,
      items: page.items.map((r) => this.toJob(r, agentById, numberById)),
    };
  }

  private toJob(
    r: Row,
    agents: Map<string, { id: string; name: string }>,
    numbers: Map<string, { id: string; e164: string | null; status: PhoneNumberStatus }>,
  ): AdminProvisioningJob {
    const steps = record(r.stepsJson);
    const agentId = typeof steps.agent_id === 'string' ? steps.agent_id : null;
    const numberId = typeof steps.number_id === 'string' ? steps.number_id : null;
    const agent = agentId ? agents.get(agentId) : undefined;
    const number = numberId ? numbers.get(numberId) : undefined;
    let activation: AdminProvisioningJob['activation'] = null;
    if (r.type === JOBS.activateAgent && agentId) {
      const view = toView(parseSteps(r.stepsJson, agentId), r);
      activation = {
        status: view.status,
        step: view.step,
        progress: view.progress,
        attempt: view.attempt,
        max_attempts: view.max_attempts,
        error: view.error,
      };
    }
    return {
      id: r.id,
      type: r.type,
      status: r.status,
      tenant: r.tenant ? { id: r.tenant.id, name: r.tenant.name } : null,
      agent: agent ? { id: agent.id, name: agent.name } : null,
      number: number ? { id: number.id, e164: number.e164, status: number.status } : null,
      activation,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
      retryable: r.status === 'failed' && r.payloadJson !== null && queueOfJobType(r.type) !== null,
    };
  }

  /**
   * Live calls per workspace from `active:*`, expired entries ignored like the §14.3
   * monitor. A scan that did not answer or stopped at its cap leaves `live` null and
   * `complete` false: what was seen is still listed, but the total is not a total.
   */
  async concurrency(now = new Date()): Promise<AdminConcurrencyResponse> {
    const allowance = platformConcurrencyLimit();
    const pct = concurrencyAlertPct();
    const base = { allowance, alert_threshold_pct: pct, checked_at: now.toISOString() };
    const scan = await this.cache.scanKeys(redisKeys.activeCallsPattern);
    if (!scan) {
      this.log.warn('concurrency: Redis did not answer the SCAN');
      return { ...base, live: null, signal: 'unknown', complete: false, tenants: [] };
    }

    const perWorkspace: Array<{ id: string; live: number }> = [];
    for (const key of scan.keys) {
      const workspaceId = workspaceOfActiveKey(key);
      if (!workspaceId) continue;
      try {
        const live = parseActiveHash(await this.redis.hgetall(key), now.getTime()).live.length;
        if (live > 0) perWorkspace.push({ id: workspaceId, live });
      } catch (error) {
        this.log.warn(`concurrency: ${key} unreadable (${String(error)})`);
      }
    }

    const ids = perWorkspace.map((w) => w.id);
    const [names, caps] = await Promise.all([
      ids.length
        ? adminDb.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
        : [],
      Promise.all(ids.map((id) => this.config.capsFor(id).catch((): WorkspaceCaps | null => null))),
    ]);
    const nameById = new Map(names.map((t) => [t.id, t.name]));
    const capsById = new Map(ids.map((id, i) => [id, caps[i] ?? null]));

    const tenants = perWorkspace
      .map((w) => {
        const c = capsById.get(w.id) ?? null;
        const cap = c?.concurrency_cap ?? null;
        return {
          tenant_id: w.id,
          tenant_name: nameById.get(w.id) ?? w.id,
          live: w.live,
          cap,
          plan_tier: c?.plan_tier ?? null,
          pct_of_cap: cap && cap > 0 ? Math.round((w.live / cap) * 100) : null,
        };
      })
      .sort((a, b) => b.live - a.live || a.tenant_name.localeCompare(b.tenant_name));

    const total = perWorkspace.reduce((n, w) => n + w.live, 0);
    if (!scan.complete) {
      this.log.warn(
        `concurrency: SCAN stopped after ${scan.keys.length} keys; the total is a floor`,
      );
      return { ...base, live: null, signal: 'unknown', complete: false, tenants };
    }
    const signal: AdminConcurrencyResponse['signal'] =
      allowance === null
        ? 'ok'
        : total >= allowance
          ? 'down'
          : total >= Math.ceil((allowance * pct) / 100)
            ? 'warn'
            : 'ok';
    return { ...base, live: total, signal, complete: true, tenants };
  }
}
