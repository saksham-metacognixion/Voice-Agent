import { Inject, Injectable, Logger } from '@nestjs/common';
import { withWorkspace } from '@portal/db';
import {
  type AcceptedJob,
  type BriefDocumentImageType,
  type ExtractDocumentRequest,
  type ExtractDocumentResponse,
  type FeedbackRequest,
  type GenerateRequest,
  BRIEF_DOCUMENT_MAX_FILE_BYTES,
  briefReadyForGeneration,
  isImageDocumentType,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { AgentEvents, parseBrief } from '../agents';
import type { WorkspaceContext } from '../auth';
import { PlatformConfigService } from '../config';
import { EventsService } from '../events';
import { extractDocumentText, finishText } from './document-text';
import { PROMPT_PROVIDER, type PromptProvider, type ProviderResult, isProviderError } from './providers';
import {
  JOBS,
  JobQueues,
  JobRecordsService,
  LOST_JOB_REASON,
  type LostJob,
  type PromptingJob,
} from '../jobs';

/**
 * The request half of §13.3 and §13.5 — everything that happens before the 202.
 *
 *     POST /agents/:id/generate → authz (Editor+) → load draft brief
 *       → enqueue generate-agent → return {job_id} (202)
 *
 * Nothing here waits for a model. The whole point of the 202 is that an LLM round trip
 * does not belong inside an HTTP request: it would hold a Fastify connection for ten
 * seconds, and — much worse — a handler that awaited generation inside `withWorkspace`
 * would hold a pooled Postgres connection for the same ten seconds and exhaust the pool
 * at about six concurrent users (CLAUDE.md, "No network I/O inside withWorkspace").
 *
 * What this service *does* do is refuse early: an incomplete brief, a paused workspace and
 * the `pause_generation` kill switch are all answered here rather than by a job that fails
 * a second later, because the customer is watching the button — and because a paused
 * workspace must not be able to spend our provider budget by clicking (§13.12).
 */
@Injectable()
export class PromptingService {
  private readonly log = new Logger(PromptingService.name);

  constructor(
    private readonly jobs: JobRecordsService,
    private readonly queues: JobQueues,
    private readonly config: PlatformConfigService,
    private readonly events: EventsService,
    @Inject(PROMPT_PROVIDER) private readonly provider: PromptProvider,
  ) {}

  /** POST /agents/:id/generate — §13.3. */
  async generate(
    ctx: WorkspaceContext,
    agentId: string,
    request: GenerateRequest,
  ): Promise<AcceptedJob> {
    await this.assertGenerationAllowed();

    const { draftVersionNo } = await withWorkspace(ctx, async (db) => {
      await this.assertWorkspaceActive(db, ctx);

      const agent = await db.agent.findFirst({
        where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null },
        select: { id: true, draftVersion: true },
      });
      if (!agent) throw AppError.notFound('Agent');

      const draft = agent.draftVersion
        ? await db.agentVersion.findUnique({
            where: { agentId_versionNo: { agentId, versionNo: agent.draftVersion } },
            select: { briefJson: true, versionNo: true },
          })
        : null;
      if (!draft)
        throw new AppError('BRIEF_INCOMPLETE', 'Fill in the brief before generating the agent.');

      // W2: "Generate is disabled until 1 & 2 are valid". Enforced here too, because the
      // button is not the only way to reach this route. Judged on the brief as the worker
      // will read it (`parseBrief` drops what it cannot parse and keeps the rest), so one
      // unreadable document cannot block generation for the whole agent.
      const ready = briefReadyForGeneration.safeParse(parseBrief(draft.briefJson));
      if (!ready.success) {
        throw new AppError(
          'BRIEF_INCOMPLETE',
          'Tell us about the business and what a good call achieves before generating.',
          ready.error.issues.map((issue) => ({
            field: `brief.${issue.path.join('.')}`,
            message: issue.message,
          })),
        );
      }

      return { draftVersionNo: draft.versionNo };
    });

    return this.enqueue(ctx, {
      agentId,
      type: JOBS.generateAgent,
      mode: request.mode,
      steps: { agent_id: agentId, base_version: draftVersionNo, mode: request.mode },
    });
  }

  /** POST /agents/:id/feedback — §13.5, `source=feedback`. */
  async feedback(
    ctx: WorkspaceContext,
    agentId: string,
    request: FeedbackRequest,
  ): Promise<AcceptedJob> {
    await this.assertGenerationAllowed();

    const baseVersionNo = await withWorkspace(ctx, async (db) => {
      await this.assertWorkspaceActive(db, ctx);

      const agent = await db.agent.findFirst({
        where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null },
        select: { id: true, draftVersion: true },
      });
      if (!agent) throw AppError.notFound('Agent');

      const wanted = request.base_version ?? agent.draftVersion;
      if (!wanted)
        throw new AppError('AGENT_NOT_GENERATED', 'Generate the agent before giving feedback on it.');

      const base = await db.agentVersion.findUnique({
        where: { agentId_versionNo: { agentId, versionNo: wanted } },
        select: { versionNo: true, promptText: true },
      });
      if (!base) throw AppError.notFound(`Version ${wanted}`);
      if (!base.promptText) {
        throw new AppError(
          'AGENT_NOT_GENERATED',
          'This version has no prompt to improve yet. Generate it first.',
        );
      }
      return base.versionNo;
    });

    return this.enqueue(ctx, {
      agentId,
      type: JOBS.patchAgent,
      mode: 'feedback',
      feedbackText: request.text,
      baseVersionNo,
      steps: { agent_id: agentId, base_version: baseVersionNo, mode: 'feedback' },
    });
  }

  /**
   * Creates the `jobs` row and queues the work — or hands back the job that is already
   * doing it.
   *
   * Duplicate submissions are the norm, not an edge case: W2 shows a three-stage progress
   * bar for ten seconds and an impatient click lands here. Returning the in-flight job's
   * id makes the second press a no-op the client cannot tell from the first, which is what
   * it should look like.
   *
   * The guarantee underneath is a partial unique index on `jobs`, not an `if`
   * (`createOrJoin`): two requests racing collide in Postgres and the loser reads back the
   * winner's id, so a customer cannot pay for two generations by clicking twice quickly.
   *
   * The same index has a failure mode: a row a dead worker left `running` would be joined
   * forever. So before joining, the queue is asked whether that job still exists
   * (`reconcileIfLost`); if it does not, the row is written off, the customer's stream is
   * told, and *this* request starts a fresh job — without waiting for the sweeper.
   */
  private async enqueue(
    ctx: WorkspaceContext,
    input: {
      agentId: string;
      type: string;
      mode: PromptingJob['mode'];
      feedbackText?: string;
      baseVersionNo?: number;
      steps: Record<string, unknown>;
    },
  ): Promise<AcceptedJob> {
    const steps = {
      ...input.steps,
      requested_by: ctx.userId,
      requested_at: new Date().toISOString(),
    };
    let { jobId, joined } = await this.jobs.createOrJoin({
      workspaceId: ctx.workspaceId,
      type: input.type,
      agentId: input.agentId,
      steps,
    });

    if (joined) {
      const lost = await this.jobs.reconcileIfLost(jobId);
      if (lost) {
        await this.announceLost(lost);
        ({ jobId, joined } = await this.jobs.createOrJoin({
          workspaceId: ctx.workspaceId,
          type: input.type,
          agentId: input.agentId,
          steps,
        }));
      }
    }
    if (joined) {
      this.log.log(`agent ${input.agentId}: ${input.type} already in flight as job ${jobId}`);
      return { job_id: jobId };
    }

    const payload = {
      jobId,
      workspaceId: ctx.workspaceId,
      agentId: input.agentId,
      userId: ctx.userId,
      mode: input.mode,
      feedbackText: input.feedbackText,
      baseVersionNo: input.baseVersionNo,
    };
    await this.jobs.recordPayload(jobId, payload);
    const queued = await this.queues.enqueuePrompting(payload);

    if (queued === 'failed') {
      // Redis is the queue; without it there is no worker to pick this up and no sweeper
      // for this queue. Say so now rather than leaving the customer on a spinner.
      await this.jobs.fail(
        jobId,
        'Could not queue the generation job.',
        {
          ...steps,
          queued: false,
          error_kind: 'not_queued',
          customer_reason: 'We could not start the generation just now. Try again in a moment.',
        },
        0,
      );
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'We could not start the generation just now. Try again in a moment.',
      );
    }

    this.log.log(`agent ${input.agentId}: ${input.type} queued as job ${jobId} (${queued})`);
    return { job_id: jobId };
  }

  /** Tells the W2 stream the job it may still be watching is not coming back. */
  private async announceLost(lost: LostJob): Promise<void> {
    if (!lost.workspaceId || !lost.agentId) return;
    await this.events
      .publish(lost.workspaceId, AgentEvents.topic(lost.agentId), AgentEvents.generationFailed, {
        agent_id: lost.agentId,
        job_id: lost.jobId,
        reason: LOST_JOB_REASON,
      })
      .catch(() => null);
  }

  /**
   * POST /agents/:id/documents/extract — W2 documents (ADR 0023): decode, read, answer.
   *
   * The agent lookup is the only database work and it closes before the file is parsed
   * or the photo is sent to the model — seconds of CPU or a provider round trip, neither
   * of which belongs inside `withWorkspace`. A photo is a vision call on the generation
   * provider, so it obeys the `pause_generation` switch and a keyless box answers
   * `NOT_CONFIGURED` rather than pretending. Nothing is persisted here: the portal writes
   * the text into the brief through the autosave, versioned and dropped with the rest.
   */
  async extractDocument(
    ctx: WorkspaceContext,
    agentId: string,
    input: ExtractDocumentRequest,
  ): Promise<ExtractDocumentResponse> {
    const base64 = input.content_base64.replace(/\s+/g, '');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0)
      throw new AppError('BAD_REQUEST', 'The file is empty.', [
        { field: 'content_base64', message: 'Empty file' },
      ]);
    if (bytes.length > BRIEF_DOCUMENT_MAX_FILE_BYTES) {
      throw new AppError(
        'BAD_REQUEST',
        `Files can be up to ${BRIEF_DOCUMENT_MAX_FILE_BYTES / (1024 * 1024)} MB.`,
        [{ field: 'content_base64', message: 'File too large' }],
      );
    }
    const isImage = isImageDocumentType(input.content_type);
    if (isImage) {
      await this.assertGenerationAllowed();
      if (!this.provider.configured) {
        this.log.error(
          'a photo was uploaded but the prompt provider has no credentials; refusing to transcribe',
        );
        throw new AppError(
          'NOT_CONFIGURED',
          'Reading photos is unavailable right now. We have been notified — upload the document as PDF or text instead.',
        );
      }
    }

    await withWorkspace(ctx, async (db) => {
      const agent = await db.agent.findFirst({
        where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!agent) throw AppError.notFound('Agent');
    });

    if (!isImage) {
      const extracted = await extractDocumentText(bytes, input.content_type);
      return { name: input.name, content_type: input.content_type, ...extracted };
    }

    let transcribed: ProviderResult<string>;
    try {
      transcribed = await this.provider.transcribeImage({
        mediaType: input.content_type as BriefDocumentImageType,
        data: base64,
        name: input.name,
      });
    } catch (error) {
      if (isProviderError(error)) {
        this.log.warn(`transcription of "${input.name}" failed (${error.kind}): ${error.message}`);
        if (error.kind === 'refused') throw unreadable();
        if (error.kind === 'not_configured')
          throw new AppError(
            'NOT_CONFIGURED',
            'Reading photos is unavailable right now. Upload the document as PDF or text instead.',
          );
        throw new AppError(
          'UPSTREAM_UNAVAILABLE',
          'We could not read the photo just now. Try again in a moment, or upload the document as PDF or text.',
        );
      }
      throw error;
    }
    if (!transcribed.value.trim()) throw unreadable();
    this.log.log(
      `transcribed "${input.name}" (${input.content_type}, ${bytes.length} B) in ${transcribed.latencyMs} ms: ${transcribed.value.length} chars`,
    );
    const extracted = finishText(transcribed.value);
    if (!extracted.text) throw unreadable();
    return { name: input.name, content_type: input.content_type, ...extracted };
  }

  /** SA12 `pause_generation` (§13.12). A kill switch is an operator's word, not a bug. */
  private async assertGenerationAllowed(): Promise<void> {
    if (await this.config.killSwitch('pause_generation')) {
      throw new AppError(
        'GENERATION_PAUSED',
        'Agent generation is paused right now. Your brief is saved — try again shortly.',
      );
    }
  }

  /**
   * SA12 pause (`tenants.paused_at`). Publishing refuses it (§13.6) and so does this: a
   * paused workspace spending our provider budget on generations would defeat the point
   * of pausing it. The worker refuses too, for a job queued a moment before the pause.
   */
  private async assertWorkspaceActive(
    db: {
      tenant: {
        findUniqueOrThrow: (args: {
          where: { id: string };
          select: { pausedAt: true };
        }) => Promise<{ pausedAt: Date | null }>;
      };
    },
    ctx: WorkspaceContext,
  ): Promise<void> {
    const tenant = await db.tenant.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { pausedAt: true },
    });
    if (tenant.pausedAt) {
      throw new AppError(
        'WORKSPACE_PAUSED',
        'This workspace is paused. Contact support to continue.',
      );
    }
  }
}

function unreadable(): AppError {
  return new AppError('DOCUMENT_UNREADABLE', 'We could not find any text in that photo. Try a sharper, straight-on picture, or upload the document as PDF or text.', [
    { field: 'content_base64', message: 'No text found' },
  ]);
}
