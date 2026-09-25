import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Prisma, withWorkspace } from '@portal/db';
import type {
  AgentSettings,
  AgentTemplate,
  AnalysisField,
  Brief,
  GeneratedPatch,
  GeneratedPrompt,
  LintResult,
} from '@portal/schemas';
import { brief as briefSchema, templateId as templateIdSchema } from '@portal/schemas';
import {
  AgentEvents,
  AgentDraftSyncService,
  AgentStackService,
  AgentsService,
  TemplatesService,
  parseAnalysisFields,
  parseBrief,
  settingsOf,
} from '../agents';
import { EventsService } from '../events';
import { JobRecordsService, type PromptingJob } from '../jobs';
import { applyGuardrails } from './guardrails';
import { lintPrompt } from './lint';
import { buildFeedbackPrompt, buildUserPrompt, normaliseAnalysisFields, outputChars } from './prompt-builder';
import { PROMPT_PROVIDER, type PromptProvider, ProviderError, isProviderError } from './providers';

/**
 * §13.3 step 2 and §13.5 step 1 — the worker side of generation.
 *
 *     build the request → call the provider → **zod** → append §9.4 guardrails
 *       → §9.5 lint → append a version → sync the Retell draft → SSE
 *
 * The order is the point, and two steps in it are load-bearing:
 *
 *   **zod before anything else.** Nothing the model says is trusted. A malformed answer,
 *   a missing field, a prompt of three characters — all of them fail here, and none of
 *   them can become an `agent_versions` row. There is no path from provider output to the
 *   database that skips the parse.
 *
 *   **Guardrails after the parse, in code.** The model is never asked to carry the §9.4
 *   block and is never trusted to have kept it (ADR 0009). Whatever it returns, the block
 *   is appended here, after validation — so an answer that omitted the rules, paraphrased
 *   them, or was talked into replacing them produces the same stored prompt.
 *
 * Two more things the worker is careful about:
 *
 *   **The customer never reads the diagnostics.** `jobs.error` and most of
 *   `jobs.steps_json` name the provider, the model, the Retell sync and whatever an SDK
 *   put in an error message. What the customer may see is written separately, as
 *   `steps_json.customer_reason`, and `GET /jobs/:id` returns that and only that.
 *
 *   **A paused workspace is refused here too.** The route refuses first (§13.12), but a
 *   job queued a moment before the pause must not spend a provider round trip either.
 *
 * Retries: BullMQ runs this up to three times. Everything before the version insert is
 * pure, so repeating it is free; the insert itself is recorded in `jobs.steps_json` and
 * skipped on a retry, so a job that died between the insert and the Retell sync resumes
 * rather than generating a second version.
 */
@Injectable()
export class GenerationWorker {
  private readonly log = new Logger(GenerationWorker.name);

  constructor(
    @Inject(PROMPT_PROVIDER) private readonly provider: PromptProvider,
    private readonly jobs: JobRecordsService,
    private readonly agents: AgentsService,
    private readonly templates: TemplatesService,
    private readonly stack: AgentStackService,
    private readonly draftSync: AgentDraftSyncService,
    private readonly events: EventsService,
  ) {}

  /** BullMQ entry point for `generate-agent` and `patch-agent`. */
  async run(job: Job<PromptingJob>): Promise<{ outcome: string; version_no?: number; reason?: string }> {
    const data = job.data;
    const attemptsLeft = Math.max(0, (job.opts.attempts ?? 1) - job.attemptsMade - 1);
    const startedAt = Date.now();

    const running = await this.jobs.markRunning(data.jobId);
    if (!running) {
      // The row is already succeeded or failed: BullMQ delivered this twice, an operator
      // retried a job that had finished, or the job sweeper wrote the row off as lost
      // while this attempt was stalled. Either way there is nothing to do.
      return { outcome: 'ignored', reason: 'job already finished' };
    }

    await this.publish(data, AgentEvents.generationStarted, { job_id: data.jobId, mode: data.mode });

    try {
      const result = data.mode === 'feedback' ? await this.patch(data, startedAt) : await this.generate(data, startedAt);
      await this.jobs.succeed(data.jobId, result.steps);
      return { outcome: result.outcome, version_no: result.versionNo };
    } catch (error) {
      const retryable = isRetryable(error);
      const willRetry = retryable && attemptsLeft > 0;
      const steps = await this.jobs.addSteps(data.jobId, {
        failed_at: new Date().toISOString(),
        error_kind: kindOf(error),
        attempts_left: attemptsLeft,
        // The one failure field a customer may read (see JobRecordsService.get).
        customer_reason: customerReason(error),
      });

      await this.jobs.fail(data.jobId, describe(error), steps, willRetry ? attemptsLeft : 0);
      this.log.error(`agent ${data.agentId}: ${data.mode} failed (${describe(error)}); ${willRetry ? 'retrying' : 'giving up'}`);

      if (!willRetry) {
        await this.publish(data, AgentEvents.generationFailed, {
          job_id: data.jobId,
          reason: customerReason(error),
        });
        // Swallowed on purpose: the job row and the SSE frame carry the outcome, and
        // throwing again would only add a BullMQ retry we have decided against.
        return { outcome: 'failed', reason: describe(error) };
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ §13.3 generate

  private async generate(data: PromptingJob, startedAt: number) {
    const watch = stopwatch();
    const context = await this.loadContext(data);
    const requested = await this.jobs.steps(data.jobId);
    const alreadyMade = await this.resumedVersion(data, requested);
    if (alreadyMade) return alreadyMade;

    const stack = context.stack;
    const template = await this.loadTemplate(context.agent.templateId);
    const contextMs = watch.lap();

    const user = buildUserPrompt({
      template,
      brief: context.brief,
      // The draft's settings, not the agent's live columns: the customer is generating
      // the agent they are *building*, which may be a different tier or language from
      // the one on the phone.
      primaryLanguage: context.settings.primary_language,
      languages: context.settings.languages,
      tier: context.settings.tier,
      businessName: context.tenant.name,
      industry: context.agent.industry,
      timezone: context.tenant.timezone,
      knowledge: context.knowledge,
      skeleton: stack.prompts.skeleton,
      alwaysAnalysisFields: stack.prompts.alwaysAnalysisFields,
      previousFeedback: context.previousFeedback,
    });

    const promptBuildMs = watch.lap();
    const answer = await this.provider.generate({
      system: stack.prompts.system,
      user,
      onFirstToken: () => void this.publish(data, AgentEvents.generationProgress, { job_id: data.jobId, stage: 'writing' }),
    });
    watch.lap(); // this stage's number is the provider's own `latencyMs`

    // ---- validated by zod inside the provider; everything below this line is trusted.
    const generated: GeneratedPrompt = answer.value;
    const promptText = applyGuardrails(generated.prompt, stack.guardrails);
    // The strict gate: the model's `analysis_fields` are lenient on the wire and become
    // `AnalysisField[]` here. A field it could not repair is dropped and named, never
    // carried forward as `choices: []` for Retell to reject at publish (§9.8).
    const { fields: analysisFields, dropped: droppedAnalysisFields } = normaliseAnalysisFields(
      [...(template?.analysis_fields ?? []), ...generated.analysis_fields],
      stack.prompts.alwaysAnalysisFields,
    );
    if (droppedAnalysisFields.length > 0) {
      this.log.warn(
        `agent ${data.agentId}: dropped ${droppedAnalysisFields.length} invalid analysis field(s): ${droppedAnalysisFields.join(', ')}`,
      );
    }

    const lint = lintPrompt(
      {
        prompt: promptText,
        greeting: generated.greeting,
        brief: context.brief,
        primaryLanguage: context.settings.primary_language,
      },
      stack.lint,
    );
    const postprocessMs = watch.lap();

    const versionNo = await this.appendVersion(data, {
      source: data.mode === 'regenerate' ? 'regenerate' : 'generated',
      brief: context.brief,
      promptText,
      greeting: generated.greeting,
      closing: generated.closing,
      analysisFields,
      settings: context.settings,
      briefCard: generated.brief_card,
      scenarios: generated.scenarios,
      lint,
      stackVersion: stack.version,
    });

    const dbMs = watch.lap();

    // Every stage of §13.3 step 2, timed, so the ≤ 10 s p95 exit check is read off the
    // job rather than guessed at: what was queue, what was the model (and how much of
    // that was waiting for its first token), what was ours. Server-side only, like the
    // rest of `steps_json` (§16): the customer sees the fields that survived, ops see
    // what the model got wrong and where the time went.
    const steps = await this.jobs.addSteps(data.jobId, {
      version_id: versionNo,
      provider: this.provider.name,
      model: answer.model,
      provider_latency_ms: answer.latencyMs,
      provider_ttft_ms: answer.firstTokenMs ?? null,
      provider_thinking_ms: answer.thinkingMs ?? null,
      provider_attempts: answer.attempts,
      queue_latency_ms: queueLatencyMs(requested, startedAt),
      context_ms: contextMs,
      prompt_build_ms: promptBuildMs,
      postprocess_ms: postprocessMs,
      db_ms: dbMs,
      lint_findings: lint.findings.length,
      usage: answer.usage ?? null,
      output_chars: outputChars(generated),
      dropped_analysis_fields: droppedAnalysisFields,
    });

    // The customer's frame goes out *before* the Retell draft sync. What they are waiting
    // for is their agent — brief card, scenarios, the prompt behind "Advanced" — and all of
    // it is stored by now. The sync is §13.3 step 6: Retell round trips that W5 needs
    // several screens later and that publish redoes anyway (§13.6), so making the W2
    // progress bar wait for them bought nothing. The job still succeeds only after the
    // sync, so `GET /jobs/:id` — the 3 s polling fallback — sees the same thing it did.
    await this.publish(data, AgentEvents.generated, {
      job_id: data.jobId,
      version_no: versionNo,
      brief_card: generated.brief_card,
      scenarios: generated.scenarios,
      warnings: generated.warnings,
      lint: lint.findings,
    });
    const sseMs = watch.lap();

    const synced = await this.syncRetell(data, versionNo);
    const retellSyncMs = watch.lap();
    const totalMs = Date.now() - startedAt;

    this.log.log(
      `agent ${data.agentId}: generated v${versionNo} in ${totalMs} ms ` +
        `(queue ${String(steps.queue_latency_ms)} · context ${contextMs} · model ${answer.latencyMs}` +
        `${answer.firstTokenMs !== undefined ? `, first token ${answer.firstTokenMs}` : ''} · ours ${postprocessMs + dbMs} ` +
        `· sse ${sseMs} · retell ${retellSyncMs}; ${answer.usage?.input_tokens ?? '?'} in / ${answer.usage?.output_tokens ?? '?'} out, ${answer.model})`,
    );
    return {
      outcome: 'generated',
      versionNo,
      steps: { ...steps, ...synced, sse_ms: sseMs, retell_sync_ms: retellSyncMs, total_ms: totalMs },
    };
  }

  // ------------------------------------------------------------------ §13.5 feedback

  private async patch(data: PromptingJob, startedAt: number) {
    const watch = stopwatch();
    const context = await this.loadContext(data);
    const requested = await this.jobs.steps(data.jobId);
    const alreadyMade = await this.resumedVersion(data, requested);
    if (alreadyMade) return alreadyMade;
    const contextMs = watch.lap();

    const base = context.baseVersion;
    if (!base?.promptText) {
      throw new JobRefusal('no_prompt', 'This version has no prompt to improve yet. Generate it first.', 'the base version has no prompt');
    }

    const stack = context.stack;
    const user = buildFeedbackPrompt({
      brief: context.brief,
      prompt: base.promptText,
      greeting: base.greeting,
      feedback: data.feedbackText ?? '',
      primaryLanguage: context.settings.primary_language,
    });

    const answer = await this.provider.patch({
      system: stack.prompts.system,
      user,
      onFirstToken: () => void this.publish(data, AgentEvents.generationProgress, { job_id: data.jobId, stage: 'writing' }),
    });
    watch.lap();
    const patched: GeneratedPatch = answer.value;

    /*
     * §9.6: "feedback that conflicts with a guardrail returns changes: [] plus an
     * explanation". That is a *successful* patch with nothing changed, not a failure — so
     * it still creates a version (the customer's words are recorded in `feedback_text` for
     * audit) and the prompt is the one they already had, guardrails re-applied.
     *
     * A refusal carries no `updated_prompt` — there was nothing to rewrite — so the stored
     * prompt is the one the customer already had, guardrails re-applied. `?? base.promptText`
     * is not defensive programming: it is the refusal path, and the zod refine guarantees a
     * prompt exists whenever `changes` is non-empty.
     */
    const refused = patched.changes.length === 0;
    const mergedBrief = refused ? context.brief : mergeBriefPatch(context.brief, patched.updated_brief);
    const promptText = applyGuardrails(
      refused ? base.promptText : (patched.updated_prompt ?? base.promptText),
      stack.guardrails,
    );
    const greeting = (refused ? base.greeting : (patched.greeting ?? base.greeting)) ?? null;

    const lint = lintPrompt(
      { prompt: promptText, greeting, brief: mergedBrief, primaryLanguage: context.settings.primary_language },
      stack.lint,
    );

    const versionNo = await this.appendVersion(data, {
      source: 'feedback',
      brief: mergedBrief,
      promptText,
      greeting,
      closing: (refused ? base.closing : (patched.closing ?? base.closing)) ?? null,
      analysisFields: parseAnalysisFields(base.analysisSchemaJson),
      settings: context.settings,
      briefCard: base.briefCardJson,
      scenarios: base.scenariosJson,
      changes: patched.changes,
      feedbackText: data.feedbackText ?? null,
      lint,
      stackVersion: stack.version,
    });

    const dbMs = watch.lap();

    const steps = await this.jobs.addSteps(data.jobId, {
      version_id: versionNo,
      provider: this.provider.name,
      model: answer.model,
      provider_latency_ms: answer.latencyMs,
      provider_ttft_ms: answer.firstTokenMs ?? null,
      provider_thinking_ms: answer.thinkingMs ?? null,
      provider_attempts: answer.attempts,
      queue_latency_ms: queueLatencyMs(requested, startedAt),
      context_ms: contextMs,
      db_ms: dbMs,
      usage: answer.usage ?? null,
      changes: patched.changes.length,
      refused,
      explanation: patched.explanation ?? null,
    });

    // Same order as `generate`, for the same reason: the customer's frame first, the
    // Retell round trips after it.
    await this.publish(data, AgentEvents.patched, {
      job_id: data.jobId,
      version_no: versionNo,
      changes: patched.changes,
      explanation: patched.explanation ?? null,
      lint: lint.findings,
    });
    const sseMs = watch.lap();

    const synced = await this.syncRetell(data, versionNo);
    const retellSyncMs = watch.lap();
    const totalMs = Date.now() - startedAt;

    this.log.log(
      `agent ${data.agentId}: feedback v${versionNo} with ${patched.changes.length} change(s) in ${totalMs} ms (model ${answer.latencyMs} · retell ${retellSyncMs})`,
    );
    return {
      outcome: refused ? 'unchanged' : 'patched',
      versionNo,
      steps: { ...steps, ...synced, sse_ms: sseMs, retell_sync_ms: retellSyncMs, total_ms: totalMs },
    };
  }

  // ------------------------------------------------------------------ shared steps

  /**
   * Reads everything the job needs in one transaction and lets the connection go before a
   * single byte reaches the provider. The brief is read *now* rather than taken from the
   * job payload, so a draft edited while the job sat in the queue is generated as it
   * stands, not as it was.
   *
   * A paused workspace is refused here, before the provider is called: the route already
   * refuses (§13.12), but a job that was queued a moment before staff paused the workspace
   * would otherwise still spend a round trip on their behalf.
   */
  private async loadContext(data: PromptingJob) {
    const stack = await this.stack.current();
    const loaded = await withWorkspace(data.workspaceId, async (db) => {
      const tenant = await db.tenant.findUniqueOrThrow({
        where: { id: data.workspaceId },
        select: { name: true, timezone: true, pausedAt: true },
      });
      if (tenant.pausedAt) {
        throw new JobRefusal('workspace_paused', 'This workspace is paused. Contact support to continue.', 'workspace is paused');
      }

      const agent = await db.agent.findFirst({
        where: { id: data.agentId, tenantId: data.workspaceId, deletedAt: null },
      });
      if (!agent) throw new JobRefusal('agent_missing', 'This agent no longer exists.', 'the agent no longer exists');

      const draftNo = data.baseVersionNo ?? agent.draftVersion;
      const draft = draftNo
        ? await db.agentVersion.findUnique({ where: { agentId_versionNo: { agentId: data.agentId, versionNo: draftNo } } })
        : null;
      if (!draft) throw new JobRefusal('draft_missing', 'The draft this job was about no longer exists.', 'the draft version disappeared');

      // Feedback the customer has already given, so a regenerate keeps the improvements
      // rather than throwing them away (W2: "your test feedback is kept").
      const feedback = await db.agentVersion.findMany({
        where: { agentId: data.agentId, source: 'feedback', feedbackText: { not: null } },
        orderBy: { versionNo: 'desc' },
        take: 5,
        select: { feedbackText: true },
      });

      // What the agent can look up (W4, the menu): named in the prompt so the script
      // says to answer from it. A source still being read counts — it will be there by
      // the time this version is on a call — and a failed or vanishing one does not.
      const knowledge = await db.knowledgeSource.findMany({
        where: { agentId: data.agentId, tenantId: data.workspaceId, status: { in: ['pending', 'syncing', 'ready'] } },
        orderBy: { createdAt: 'asc' },
        select: { name: true, role: true },
      });

      return { agent, tenant, draft, knowledge, previousFeedback: feedback.map((row) => row.feedbackText!).reverse() };
    });

    return {
      agent: loaded.agent,
      tenant: loaded.tenant,
      brief: parseBrief(loaded.draft.briefJson),
      settings: settingsOf(loaded.draft, loaded.agent),
      baseVersion: loaded.draft,
      knowledge: loaded.knowledge.map((source) => ({ name: source.name, role: source.role })),
      previousFeedback: data.mode === 'regenerate' ? loaded.previousFeedback : undefined,
      stack,
    };
  }

  private async loadTemplate(templateId: string | null): Promise<AgentTemplate | null> {
    if (!templateId || !templateIdSchema.safeParse(templateId).success) return null;
    try {
      return await this.templates.require(templateId);
    } catch {
      // A template that has been retired since the agent was created is not a reason to
      // fail a generation: the brief carries everything that matters.
      this.log.warn(`template ${templateId} is gone; generating from the brief alone`);
      return null;
    }
  }

  /**
   * The retry guard. A job that already wrote its version records the number in
   * `steps_json`; a retry after that point resumes at the Retell sync rather than
   * generating — and paying for — a second version.
   */
  private async resumedVersion(data: PromptingJob, steps: Record<string, unknown>) {
    const versionNo = typeof steps.version_id === 'number' ? steps.version_id : null;
    if (versionNo === null) return null;

    this.log.warn(`agent ${data.agentId}: job ${data.jobId} already wrote v${versionNo}; resuming at the Retell sync`);
    const synced = await this.syncRetell(data, versionNo);
    return { outcome: 'resumed', versionNo, steps: { ...steps, ...synced } };
  }

  private async appendVersion(
    data: PromptingJob,
    input: {
      source: 'generated' | 'regenerate' | 'feedback';
      brief: Brief;
      promptText: string;
      greeting: string | null;
      closing: string | null;
      analysisFields: AnalysisField[];
      settings: AgentSettings;
      briefCard?: unknown;
      scenarios?: unknown;
      changes?: string[];
      feedbackText?: string | null;
      lint: LintResult;
      stackVersion: number;
    },
  ): Promise<number> {
    return withWorkspace(data.workspaceId, (db) =>
      this.agents.appendVersion(db, {
        agentId: data.agentId,
        source: input.source,
        brief: input.brief,
        promptText: input.promptText,
        greeting: input.greeting,
        closing: input.closing,
        analysisFields: input.analysisFields,
        settings: input.settings,
        briefCard: input.briefCard,
        scenarios: input.scenarios,
        changes: input.changes,
        feedbackText: input.feedbackText,
        lint: input.lint,
        createdBy: data.userId,
        stackVersion: input.stackVersion,
      }),
    );
  }

  /**
   * §13.3 step 6 — push the draft to Retell so W5's test call has something to ring.
   *
   * Deliberately **not** fatal. The version is already stored and lint-clean; publishing
   * re-syncs from it anyway (§13.6), so a Retell outage during generation costs a test
   * call, not the customer's work. The failure is recorded on the job, which is what SA12
   * and the D5 benchmark read — and never what the customer reads.
   *
   * The draft is synced with the *version's* settings, so a test call rings the tier and
   * voice the customer is building, not the one that is live.
   */
  private async syncRetell(data: PromptingJob, versionNo: number): Promise<Record<string, unknown>> {
    try {
      const outcome = await this.draftSync.syncVersion(data.workspaceId, data.agentId, versionNo);
      if (outcome.status === 'skipped') return { retell_sync: 'skipped', retell_sync_reason: outcome.reason };
      return { retell_sync: 'ok', retell_agent_version: outcome.retellAgentVersion };
    } catch (error) {
      this.log.warn(`agent ${data.agentId}: Retell draft sync failed (${describe(error)}); publish will re-sync`);
      return { retell_sync: 'failed', retell_error: describe(error).slice(0, 300) };
    }
  }

  private async publish(data: PromptingJob, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.events
      .publish(data.workspaceId, AgentEvents.topic(data.agentId), type, { agent_id: data.agentId, ...payload })
      .catch(() => null);
  }
}

/**
 * A job that must not run and must not be retried, for a reason that is ours rather than
 * the provider's: the workspace was paused, the agent or draft is gone, the base version
 * has no prompt. Carries the sentence the customer may read separately from the one the
 * log gets.
 */
export class JobRefusal extends Error {
  constructor(
    readonly kind: 'workspace_paused' | 'agent_missing' | 'draft_missing' | 'no_prompt',
    readonly customerReason: string,
    message: string,
  ) {
    super(message);
    this.name = 'JobRefusal';
  }
}

/**
 * `updated_brief` carries only what changed (§9.6), and whatever it carries is validated
 * before it is merged — an LLM may not widen a field past the schema any more than a
 * client may.
 */
export function mergeBriefPatch(current: Brief, patch: Partial<Brief>): Brief {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  const parsed = briefSchema.safeParse(merged);
  // A patch that would make the brief invalid is dropped wholesale rather than partially
  // applied: the prompt is still the model's, but the structured brief stays coherent.
  return parsed.success ? parsed.data : current;
}

/** Lap timer for the per-stage timings in `steps_json`: each call returns the ms since the last. */
function stopwatch(): { lap(): number } {
  let last = Date.now();
  return {
    lap() {
      const now = Date.now();
      const ms = now - last;
      last = now;
      return ms;
    },
  };
}

/** Between the route accepting the request (`steps_json.requested_at`) and the worker picking it up. */
function queueLatencyMs(steps: Record<string, unknown>, startedAt: number): number {
  const requestedAt = typeof steps.requested_at === 'string' ? Date.parse(steps.requested_at) : NaN;
  return Number.isFinite(requestedAt) ? Math.max(0, startedAt - requestedAt) : 0;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof JobRefusal) return false;
  if (isProviderError(error)) return error.retryable;
  return true;
}

function kindOf(error: unknown): string {
  if (error instanceof JobRefusal) return error.kind;
  if (isProviderError(error)) return error.kind;
  return 'internal';
}

/** What goes in the log and on `jobs.error`. Includes the kind; never shown to a customer. */
function describe(error: unknown): string {
  if (error instanceof JobRefusal) return `${error.kind}: ${error.message}`;
  if (isProviderError(error)) return `${error.kind}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * What the customer sees — on the SSE frame and on `GET /jobs/:id`. W2's copy is
 * "Couldn't generate — try again", and these are the few cases where saying more actually
 * helps them act. Nothing here is derived from an error *message*: only from its kind.
 */
export function customerReason(error: unknown): string {
  if (error instanceof JobRefusal) return error.customerReason;
  if (!isProviderError(error)) return 'Something went wrong while writing your agent.';
  switch (error.kind) {
    case 'timeout':
    case 'unavailable':
    case 'rate_limited':
      return 'Writing your agent took too long. Your brief is saved — try again.';
    case 'refused':
      return 'We could not write an agent from this brief. Try describing the business differently.';
    case 'not_configured':
      return 'Agent generation is unavailable right now. We have been notified.';
    default:
      return "Couldn't generate — try again.";
  }
}

/** Keeps Prisma's JSON type import honest for the steps payloads above. */
export type StepsJson = Prisma.InputJsonValue;
export { ProviderError };
