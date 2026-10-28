import { Injectable, Logger } from '@nestjs/common';
import { Prisma, adminDb, withWorkspace } from '@portal/db';
import type { AgentDetail, AgentSettings, LintResult, PublishResponse } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { EventsService } from '../events';
import { applyGuardrails } from '../prompting/guardrails';
import { lintErrors, lintPrompt } from '../prompting/lint';
import { RuntimeCacheService } from '../runtime-cache';
import { AgentEvents } from './agent-events';
import { AgentRetellService } from './agent-retell.service';
import { runtimeAddOns } from './agent-runtime';
import { AgentStackService } from './agent-stack.service';
import { AgentsService, liveColumnsFrom, parseAnalysisFields, parseBrief, settingsOf } from './agents.service';

/** How long a publish may hold its lease before another attempt may take it over. */
export const PUBLISH_LEASE_MS = 120_000;

/**
 * §13.6 Publish, plus pause, resume and delete — the three other places where local state
 * and Retell have to agree.
 *
 *     lint (block on errors) → RetellGateway.publish → agents.published_version
 *       + agents.{tier, voice, languages, max duration, recording} ← the version's settings
 *       → audit_log → runtime cache → SSE. Numbers bound to latest_published pick it up.
 *
 * The shape of this file is dictated by one constraint: **no network I/O inside
 * `withWorkspace`** (CLAUDE.md). A publish is four Retell calls, so it cannot be one
 * transaction. It is instead read → close → Retell → reopen to write, and everything that
 * makes that safe is explicit:
 *
 *   *Exclusion* is `agents.publishing_since`, a leased claim taken by a conditional
 *   UPDATE and released only by the publisher that holds it — the release is conditional
 *   on the exact timestamp the claim wrote, so a publish that overran its lease cannot
 *   clear the lease a later publisher has since legitimately taken. A worker that dies
 *   mid-publish releases its claim two minutes later rather than never.
 *
 *   *Idempotency* is the state itself. A publish of a version that is already live and
 *   already mapped to a Retell version returns `already_published: true` and touches
 *   nothing. Every Retell step is separately idempotent, so a retry after a failure —
 *   whether Retell or Postgres failed — converges rather than duplicating.
 *
 *   *Ordering* puts the risky step in the middle and the cheap, recoverable writes
 *   around it. `retell_agent_version` is written as soon as it is known, before the
 *   publish call, so a crash between the two leaves a mapping the retry can use instead
 *   of branching a second Retell draft.
 *
 *   *Activation* is the persist step. The version's settings become the agent's live
 *   columns in the same transaction as `published_version`, so the billing rate, the
 *   Retell stack and `num:{e164}` change together — never one without the others.
 */
@Injectable()
export class AgentPublishService {
  private readonly log = new Logger(AgentPublishService.name);

  constructor(
    private readonly agents: AgentsService,
    private readonly stack: AgentStackService,
    private readonly retell: AgentRetellService,
    private readonly events: EventsService,
    private readonly runtimeCache: RuntimeCacheService,
    private readonly config: PlatformConfigService,
  ) {}

  /**
   * `refresh` is the knowledge worker's republish: the version is already live, but the
   * platform copy predates the agent's knowledge base (the LLM is versioned with the
   * agent, so a base attached after publish is not seen until a new platform version is
   * published — ADR 0024). It skips the "already live" short-circuit and nothing else.
   */
  async publish(ctx: WorkspaceContext, agentId: string, versionNo?: number, opts: { refresh?: boolean } = {}): Promise<PublishResponse> {
    const stack = await this.stack.current();

    // ---------------------------------------------------------------- read
    const snapshot = await withWorkspace(ctx, async (db) => {
      const agent = await db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null } });
      if (!agent) throw AppError.notFound('Agent');

      const wanted = versionNo ?? agent.draftVersion;
      if (!wanted) throw new AppError('AGENT_NOT_GENERATED', 'This agent has no version to publish yet.');

      const version = await db.agentVersion.findUnique({ where: { agentId_versionNo: { agentId, versionNo: wanted } } });
      if (!version) throw AppError.notFound(`Version ${wanted}`);

      const tenant = await db.tenant.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { name: true, timezone: true, pausedAt: true, recordingNotice: true, recordingNoticeText: true },
      });
      return { agent, version, tenant };
    });

    const { agent, version, tenant } = snapshot;
    if (tenant.pausedAt) {
      throw new AppError('WORKSPACE_PAUSED', 'This workspace is paused. Contact support to publish.');
    }
    if (!version.promptText) {
      throw new AppError(
        'AGENT_NOT_GENERATED',
        'This version has no prompt yet. Generate the agent before publishing.',
      );
    }

    // ---------------------------------------------------------------- lint (§13.6)
    const settings = settingsOf(version, agent);
    const briefValue = parseBrief(version.briefJson);
    const promptText = applyGuardrails(version.promptText, stack.guardrails);
    const lint = lintPrompt(
      { prompt: promptText, greeting: version.greeting, brief: briefValue, primaryLanguage: settings.primary_language },
      stack.lint,
    );
    const errors = lintErrors(lint);
    if (errors.length > 0) {
      // Recorded on the version before refusing, so the D3 lint panel shows exactly what
      // blocked the publish without the client having to hold the response.
      await this.storeLint(ctx.workspaceId, agentId, version.versionNo, lint);
      throw new AppError(
        'LINT_FAILED',
        'This version cannot go live yet.',
        errors.map((finding) => ({ field: finding.field ?? 'prompt', message: finding.message })),
      );
    }

    // ---------------------------------------------------------------- already live?
    if (!opts.refresh && isLive(agent, version)) {
      return { agent_id: agentId, version_no: version.versionNo, status: 'live', lint, already_published: true };
    }

    // ---------------------------------------------------------------- the stack (admin SA6)
    // Before the lease: a missing stack is an operator problem, not a race, and there is
    // nothing to hold a lock for. No compiled-in fallback — see AgentRetellService.
    const tierStack = await this.stack.tierStack(settings.tier);
    if (!tierStack) {
      this.log.error(`agent ${agentId}: no ${settings.tier} stack in agent_stack_configs; refusing to publish`);
      throw new AppError('NOT_CONFIGURED', 'Publishing is unavailable right now. We have been notified.');
    }

    // ---------------------------------------------------------------- claim
    const lease = await this.claimLease(agentId);
    if (!lease) {
      throw new AppError('PUBLISH_IN_PROGRESS', 'This agent is already being published. Try again in a moment.');
    }

    try {
      // The check above ran against a snapshot taken before the lease existed, so a
      // publish that finished in between would not have been visible to it. Ask again now
      // that nobody else can be publishing: without this, a duplicate request arriving
      // just after the first one committed would branch and publish a second Retell
      // version for a version that is already live.
      const fresh = await withWorkspace(ctx, async (db) => {
        const freshAgent = await db.agent.findFirstOrThrow({ where: { id: agentId, tenantId: ctx.workspaceId } });
        const freshVersion = await db.agentVersion.findUniqueOrThrow({
          where: { agentId_versionNo: { agentId, versionNo: version.versionNo } },
        });
        const freshSettings = settingsOf(freshVersion, freshAgent);
        // The voice will be copied onto `agents.voice_id`, a foreign key into the catalogue.
        // A voice that left the catalogue since the draft chose it is a clear refusal now
        // rather than a constraint violation in the persist step.
        const voice = freshSettings.voice_id
          ? await db.voice.findUnique({ where: { retellVoiceId: freshSettings.voice_id }, select: { retellVoiceId: true } })
          : null;
        if (freshSettings.voice_id && !voice) {
          throw new AppError('BAD_REQUEST', 'The voice this version uses is no longer available. Pick another in the Voice tab.', [
            { field: 'voice_id', message: 'Unknown voice' },
          ]);
        }
        return { agent: freshAgent, version: freshVersion, settings: freshSettings };
      });
      if (!opts.refresh && isLive(fresh.agent, fresh.version)) {
        return { agent_id: agentId, version_no: version.versionNo, status: 'live', lint, already_published: true };
      }

      // -------------------------------------------------------------- Retell
      // Every setting comes from the *version* — never from the agent row, which is what
      // is live right now and may be a different tier, voice or ceiling. Publishing v3
      // must put v3 on the phone, and rolling back to v1 must put v1's voice back too.
      const flags = await this.config.flagsFor(ctx.workspaceId);
      const sync = await this.retell.syncDraft({
        agentId,
        agentName: fresh.agent.name,
        // Read from the fresh row: a publish that ran while this one waited may have
        // created the Retell objects, and creating a second pair would orphan the first.
        retellAgentId: fresh.agent.retellAgentId,
        retellLlmId: fresh.agent.retellLlmId,
        retellKbId: fresh.agent.retellKbId,
        promptText,
        greeting: version.greeting,
        brief: briefValue,
        analysisFields: parseAnalysisFields(version.analysisSchemaJson),
        voiceId: fresh.settings.voice_id,
        voiceSpeed: fresh.settings.voice_speed,
        voiceTemperature: fresh.settings.voice_temperature,
        primaryLanguage: fresh.settings.primary_language,
        languages: fresh.settings.languages,
        maxCallDurationS: fresh.settings.max_call_duration_s,
        timezone: tenant.timezone,
        businessName: tenant.name,
        stack: tierStack,
        guardrails: stack.guardrails,
        // Denoise and PII removal with the plan gate applied, and the recording notice
        // (QA-079, QA-081) — the same function the draft sync uses.
        ...runtimeAddOns(fresh.settings, flags.gates, tenant),
      });

      // The mapping, written before the publish call. If the process dies in the next
      // line, the retry finds the Retell ids and the draft number here rather than
      // branching a second draft that nobody would ever publish.
      await this.storeRetellIds(ctx.workspaceId, agentId, version.versionNo, sync);

      await this.retell.publish(sync.agentId, sync.draftVersion, `v${version.versionNo}`);

      // -------------------------------------------------------------- persist + activate
      await withWorkspace(ctx, async (db) => {
        await db.agentVersion.update({
          where: { agentId_versionNo: { agentId, versionNo: version.versionNo } },
          data: { publishedAt: new Date(), retellAgentVersion: sync.draftVersion, lintJson: lint as unknown as Prisma.InputJsonValue },
        });
        await db.agent.update({
          where: { id: agentId },
          data: {
            publishedVersion: version.versionNo,
            // The version's settings become the live ones here and only here: the billing
            // rate (`agents.tier`), the duration ceiling and the voice change in the same
            // transaction as `published_version`, so the phone, the wallet and `num:{e164}`
            // can never describe three different agents.
            ...liveColumnsFrom(fresh.settings),
            // A paused agent stays paused. Publishing is "this version is the one to
            // run", not "put it back on the phone" — un-pausing is `POST /resume`, and
            // doing it here would quietly re-answer calls the customer stopped.
            status: fresh.agent.status === 'paused' ? 'paused' : 'live',
            draftVersion: fresh.agent.draftVersion ?? version.versionNo,
          },
        });
        await this.agents.audit(db, ctx, 'agent.published', agentId, {
          version_no: version.versionNo,
          retell_agent_version: sync.draftVersion,
          settings: fresh.settings,
          lint_warnings: lint.findings.length,
          stack_version: stack.version,
        });
      });

      // A live agent changes what the §13.9 hot path must answer — `num:{e164}` carries
      // `agent_live`, the tier, the rate and the agent's duration ceiling (CLAUDE.md:
      // refresh from every mutating path). Never allowed to fail the publish: the
      // 5-minute schedule repairs it.
      await this.refreshRuntimeCache(ctx.workspaceId, 'publish');

      await this.events.publish(ctx.workspaceId, AgentEvents.topic(agentId), AgentEvents.published, {
        agent_id: agentId,
        version_no: version.versionNo,
        lint: lint.findings,
      });
      this.log.log(`agent ${agentId} published v${version.versionNo} as Retell v${sync.draftVersion} (${describeSettings(fresh.settings)})`);

      return {
        agent_id: agentId,
        version_no: version.versionNo,
        status: fresh.agent.status === 'paused' ? 'paused' : 'live',
        lint,
        already_published: false,
      };
    } catch (error) {
      this.log.error(`agent ${agentId} publish of v${version.versionNo} failed: ${message(error)}`);
      throw asPublishError(error);
    } finally {
      await this.releaseLease(agentId, lease);
    }
  }

  // ------------------------------------------------------------------ pause / resume

  /**
   * POST /agents/:id/pause. Local state is what matters: `num:{e164}` carries `agent_live`
   * and the §13.9 checks decline on it, so a paused agent stops answering as soon as the
   * runtime cache is refreshed — without a Retell call, which is why a Retell outage
   * cannot stop a customer from pulling their agent off the phone.
   *
   * Idempotent: pausing a paused agent is a no-op with the same 200.
   */
  async pause(ctx: WorkspaceContext, agentId: string): Promise<AgentDetail> {
    const changed = await withWorkspace(ctx, async (db) => {
      const agent = await db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null } });
      if (!agent) throw AppError.notFound('Agent');
      if (agent.status === 'paused') return false;

      await db.agent.update({ where: { id: agentId }, data: { status: 'paused' } });
      await this.agents.audit(db, ctx, 'agent.paused', agentId, { was: agent.status });
      return true;
    });

    if (changed) {
      await this.refreshRuntimeCache(ctx.workspaceId, 'pause');
      await this.events.publish(ctx.workspaceId, AgentEvents.topic(agentId), AgentEvents.paused, { agent_id: agentId });
    }
    return this.agents.get(ctx, agentId);
  }

  /** The other half of the D3 "Pause/Resume" menu item. Only a published agent can go live. */
  async resume(ctx: WorkspaceContext, agentId: string): Promise<AgentDetail> {
    const changed = await withWorkspace(ctx, async (db) => {
      const agent = await db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null } });
      if (!agent) throw AppError.notFound('Agent');
      if (agent.status !== 'paused') return false;
      if (agent.publishedVersion === null) {
        throw new AppError('AGENT_NOT_PUBLISHED', 'Publish this agent before putting it back on the phone.');
      }

      await db.agent.update({ where: { id: agentId }, data: { status: 'live' } });
      await this.agents.audit(db, ctx, 'agent.resumed', agentId, { version_no: agent.publishedVersion });
      return true;
    });

    if (changed) {
      await this.refreshRuntimeCache(ctx.workspaceId, 'resume');
      await this.events.publish(ctx.workspaceId, AgentEvents.topic(agentId), AgentEvents.resumed, { agent_id: agentId });
    }
    return this.agents.get(ctx, agentId);
  }

  // ------------------------------------------------------------------ delete

  /**
   * DELETE /agents/:id — a soft delete (§17).
   *
   * The row stays because `calls` references it and calls are billing history; the
   * versions stay because they are what a disputed call was answered with. What is
   * actually destroyed is the Retell side, so a deleted agent cannot answer even if a
   * number were somehow still pointed at it.
   *
   * A number attached to the agent is a refusal, not a cascade: releasing someone's phone
   * number as a side effect of deleting an agent is not a decision this route gets to
   * make (D4 "Change agent" is the supported path).
   *
   * The answer is `{deleted}` and nothing else. A Retell cleanup failure is logged and
   * audited — it is our problem to finish, and its error text names the platform.
   */
  async remove(ctx: WorkspaceContext, agentId: string): Promise<{ deleted: boolean }> {
    const target = await withWorkspace(ctx, async (db) => {
      const agent = await db.agent.findFirst({ where: { id: agentId, tenantId: ctx.workspaceId } });
      if (!agent) throw AppError.notFound('Agent');
      if (agent.deletedAt) return null;

      const numbers = await db.phoneNumber.count({
        where: { agentId, tenantId: ctx.workspaceId, status: { notIn: ['released', 'releasing'] } },
      });
      if (numbers > 0) {
        throw new AppError(
          'AGENT_IN_USE',
          `${numbers} phone number${numbers === 1 ? ' is' : 's are'} still pointed at this agent. Move them to another agent first.`,
        );
      }

      const live = await db.call.count({ where: { agentId, tenantId: ctx.workspaceId, status: 'in_progress' } });
      if (live > 0) {
        throw new AppError('AGENT_IN_USE', 'This agent is on a call right now. Try again when it ends.');
      }

      return { retellAgentId: agent.retellAgentId, retellLlmId: agent.retellLlmId, name: agent.name };
    });

    if (!target) return { deleted: false };

    // Retell first, and outside the transaction. A failure here is recorded rather than
    // fatal: the agent must still become undeletable-by-accident in our database, and the
    // orphaned Retell object is detached from every number by the check above.
    const retellErrors = await this.retell.destroy(target);
    if (retellErrors.length) this.log.warn(`agent ${agentId}: Retell cleanup incomplete — ${retellErrors.join('; ')}`);

    await withWorkspace(ctx, async (db) => {
      await db.agent.updateMany({
        where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null },
        data: { deletedAt: new Date(), status: 'paused', retellAgentId: null, retellLlmId: null },
      });
      await this.agents.audit(db, ctx, 'agent.deleted', agentId, {
        name: target.name,
        retell_cleanup_errors: retellErrors,
      });
    });

    await this.refreshRuntimeCache(ctx.workspaceId, 'delete');
    await this.events.publish(ctx.workspaceId, AgentEvents.topic(agentId), AgentEvents.deleted, { agent_id: agentId });
    this.log.log(`agent ${agentId} deleted in workspace ${ctx.workspaceId}`);
    return { deleted: true };
  }

  // ------------------------------------------------------------------ the lease

  /**
   * One conditional UPDATE. `updateMany` returns the number of rows it touched, so
   * "did I get the lock?" is the same round trip as taking it — no read-then-write race.
   *
   * Returns the timestamp it wrote, which is the lease **token**: `releaseLease` clears
   * the lease only if the column still holds this exact value. Without that, a publish
   * that stalled past `PUBLISH_LEASE_MS` inside a Retell call would, on waking, clear the
   * lease a second publisher had legitimately taken over — and a third could then run
   * alongside the second, which is the interleaving the lease exists to prevent.
   *
   * On `adminDb` deliberately: this is plumbing, not customer data, and the caller has
   * already established that the agent belongs to the workspace. Public so the race can
   * be tested directly; nothing outside this module should call it.
   */
  async claimLease(agentId: string, now = new Date()): Promise<Date | null> {
    const staleBefore = new Date(now.getTime() - PUBLISH_LEASE_MS);
    const { count } = await adminDb.agent.updateMany({
      where: {
        id: agentId,
        deletedAt: null,
        OR: [{ publishingSince: null }, { publishingSince: { lt: staleBefore } }],
      },
      data: { publishingSince: now },
    });
    return count === 1 ? now : null;
  }

  /** Clears the lease only if it is still ours. Returns whether anything was cleared. */
  async releaseLease(agentId: string, token: Date | null): Promise<boolean> {
    if (!token) return false;
    try {
      const { count } = await adminDb.agent.updateMany({
        where: { id: agentId, publishingSince: token },
        data: { publishingSince: null },
      });
      if (count === 0) {
        this.log.warn(`agent ${agentId}: publish lease from ${token.toISOString()} was already taken over; not releasing the new holder's`);
      }
      return count === 1;
    } catch (error) {
      this.log.warn(`agent ${agentId}: could not release the publish lease: ${message(error)}`);
      return false;
    }
  }

  private async storeRetellIds(
    workspaceId: string,
    agentId: string,
    versionNo: number,
    sync: { agentId: string; llmId: string; draftVersion: number },
  ): Promise<void> {
    await withWorkspace(workspaceId, async (db) => {
      await db.agent.update({
        where: { id: agentId },
        data: { retellAgentId: sync.agentId, retellLlmId: sync.llmId },
      });
      await db.agentVersion.update({
        where: { agentId_versionNo: { agentId, versionNo } },
        data: { retellAgentVersion: sync.draftVersion },
      });
    });
  }

  private async storeLint(workspaceId: string, agentId: string, versionNo: number, lint: LintResult): Promise<void> {
    await withWorkspace(workspaceId, (db) =>
      db.agentVersion.update({
        where: { agentId_versionNo: { agentId, versionNo } },
        data: { lintJson: lint as unknown as Prisma.InputJsonValue },
      }),
    ).catch((error: unknown) => this.log.warn(`agent ${agentId}: could not store the lint result: ${message(error)}`));
  }

  private async refreshRuntimeCache(workspaceId: string, why: string): Promise<void> {
    await this.runtimeCache
      .refresh(workspaceId)
      .catch((error: unknown) => this.log.warn(`runtime-cache refresh after ${why} failed: ${message(error)}`));
  }
}

/** Live means all four agree: our row, its status, the version's stamp and Retell's. */
function isLive(
  agent: { publishedVersion: number | null; status: string },
  version: { versionNo: number; publishedAt: Date | null; retellAgentVersion: number | null },
): boolean {
  return (
    agent.publishedVersion === version.versionNo &&
    // `paused` counts: the version *is* published, the agent is just not answering. A
    // publish of it should be a no-op rather than a second trip through Retell.
    (agent.status === 'live' || agent.status === 'paused') &&
    version.publishedAt !== null &&
    version.retellAgentVersion !== null
  );
}

/**
 * A Retell failure is not our customer's mistake and must not read as one. Anything that
 * already carries a §16 code keeps it; everything else becomes 503, which is what the
 * portal shows a "try again" for — and which never carries the upstream's message.
 */
function asPublishError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  return new AppError(
    'UPSTREAM_UNAVAILABLE',
    'We could not put this agent live just now. Nothing was changed — try again in a moment.',
  );
}

function describeSettings(settings: AgentSettings): string {
  return `${settings.tier}, voice ${settings.voice_id ?? 'default'}, ${settings.max_call_duration_s}s`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
