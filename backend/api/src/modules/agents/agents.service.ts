import { Injectable, Logger } from '@nestjs/common';
import { Prisma, withWorkspace, type VersionSource, type WorkspaceDb } from '@portal/db';
import {
  type AgentDetail,
  type AgentDraftPatch,
  type AgentSettings,
  type AgentSummary,
  type AgentVersionDetail,
  type AgentVersionSummary,
  type AgentsQuery,
  type AnalysisField,
  type Brief,
  type CreateAgentRequest,
  type LintRequest,
  type LintResult,
  type Page,
  type PromptUpdate,
  type Scenario,
  agentSettings as agentSettingsSchema,
  analysisField,
  retellLanguage,
  brief as briefSchema,
  briefDocument as briefDocumentSchema,
  briefCard as briefCardSchema,
  defaultAgentSettings,
  lintResult as lintResultSchema,
  scenario as scenarioSchema,
} from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { cursorArgs, toPage } from '../../common/pagination';
import type { WorkspaceContext } from '../auth';
import { EventsService } from '../events';
import { applyGuardrails, stripGuardrails } from '../prompting/guardrails';
import { lintPrompt } from '../prompting/lint';
import { RuntimeCacheService } from '../runtime-cache';
import { AgentStackService } from './agent-stack.service';
import { AgentEvents } from './agent-events';
import { TemplatesService } from './templates.service';

/**
 * Agents and their versions (§9.9, §13.3, §16) — everything except the LLM (that is
 * `prompting`) and Retell (that is `AgentPublishService`).
 *
 * Three rules shape every method here:
 *
 *   **Versions are immutable.** A generation, a feedback patch or a manual prompt edit
 *   appends a row; nothing is rewritten. The single exception the spec asks for is the
 *   W2 autosave, which writes into the draft — and "the draft" is defined narrowly as
 *   *the newest version of the agent that has not been published*. A patch against
 *   anything else forks a new version instead. The database enforces the same line
 *   (`agent_versions_immutable`), so a service that got it wrong would fail loudly
 *   rather than quietly rewrite history.
 *
 *   **A draft never changes what is live.** Tier, voice, languages, the duration ceiling
 *   and recording travel *with the version* (`agent_versions.settings_json`); the copy on
 *   `agents` is what the phone runs and what a call is billed at, and only a publish
 *   writes it. The D3 Voice tab can flip a live Premium agent's draft to Standard all
 *   afternoon and every call that afternoon still bills at Premium — because that is
 *   what is answering. The one agent-level field this route does write live is the
 *   name, which is a label, and even that refreshes the runtime cache (it appears in
 *   `num:{e164}` as `agent_name`).
 *
 *   **Tenancy is the workspace, always.** Every read and write goes through
 *   `withWorkspace(ctx)`, so RLS is the second guard and an agent id from another
 *   workspace is a 404 rather than a leak (ADR 0006). There is no method here that takes
 *   an agent id without a context.
 */
@Injectable()
export class AgentsService {
  private readonly log = new Logger(AgentsService.name);

  constructor(
    private readonly templates: TemplatesService,
    private readonly stack: AgentStackService,
    private readonly events: EventsService,
    private readonly runtimeCache: RuntimeCacheService,
  ) {}

  // ------------------------------------------------------------------ create (W1)

  /**
   * POST /agents {template_id, industry} — W1 Continue.
   *
   * One transaction: the agent, its v1 draft pre-filled from the template, and the audit
   * row. A failure anywhere rolls all three back; there is no state in which an agent
   * exists without a version, which every later method would have to defend against.
   *
   * The template is loaded *before* the transaction opens. It is a database read and a
   * file read, and neither belongs inside a transaction that holds a pooled connection
   * (CLAUDE.md, "No network I/O inside withWorkspace" — the same reasoning).
   *
   * The agent's live columns start from the same defaults as the draft. Nothing bills
   * against them until a publish: a draft agent is never `live`, so `num:{e164}` declines
   * for it and the rate on `agents.tier` is never read for a call.
   */
  async create(ctx: WorkspaceContext, input: CreateAgentRequest): Promise<AgentDetail> {
    const template = await this.templates.require(input.template_id);
    const caps = await this.agentCount(ctx);

    const prefill = briefSchema.parse(template.brief_prefill);
    const settings = defaultAgentSettings(template.default_tier);
    const name = input.name?.trim() || template.name;

    const agentId = await withWorkspace(ctx, async (db) => {
      const agent = await db.agent.create({
        data: {
          tenantId: ctx.workspaceId,
          name,
          templateId: template.id,
          industry: input.industry,
          ...liveColumnsFrom(settings),
          draftVersion: 1,
          status: 'draft',
        },
      });

      await db.agentVersion.create({
        data: {
          agentId: agent.id,
          versionNo: 1,
          source: 'manual',
          briefJson: prefill as unknown as Prisma.InputJsonValue,
          analysisSchemaJson: template.analysis_fields as unknown as Prisma.InputJsonValue,
          settingsJson: settings as unknown as Prisma.InputJsonValue,
          createdBy: ctx.userId,
        },
      });

      await this.audit(db, ctx, 'agent.created', agent.id, {
        template_id: template.id,
        template_version: template.version,
        industry: input.industry ?? null,
        existing_agents: caps,
      });

      return agent.id;
    });

    this.log.log(`agent ${agentId} created from ${template.id} in workspace ${ctx.workspaceId}`);
    await this.events.publish(ctx.workspaceId, AgentEvents.topic(agentId), AgentEvents.created, {
      agent_id: agentId,
      template_id: template.id,
    });
    return this.get(ctx, agentId);
  }

  // ------------------------------------------------------------------ read

  async list(ctx: WorkspaceContext, query: AgentsQuery): Promise<Page<AgentSummary>> {
    const rows = await withWorkspace(ctx, (db) =>
      db.agent.findMany({
        ...cursorArgs(query),
        where: {
          tenantId: ctx.workspaceId,
          deletedAt: null,
          ...(query.status ? { status: query.status } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { _count: { select: { phoneNumbers: true } } },
      }),
    );
    const page = toPage(rows, query);
    return {
      next_cursor: page.next_cursor,
      items: page.items.map((row) => toSummary(row, row._count.phoneNumbers)),
    };
  }

  async get(ctx: WorkspaceContext, agentId: string): Promise<AgentDetail> {
    const { agent, versions, numbers } = await withWorkspace(ctx, async (db) => {
      const agent = await this.loadAgent(db, ctx, agentId);
      const wanted = [agent.draftVersion, agent.publishedVersion].filter(
        (v): v is number => v !== null,
      );
      const [versions, numbers] = await Promise.all([
        wanted.length
          ? db.agentVersion.findMany({ where: { agentId, versionNo: { in: wanted } } })
          : Promise.resolve([]),
        db.phoneNumber.count({ where: { agentId, tenantId: ctx.workspaceId } }),
      ]);
      return { agent, versions, numbers };
    });

    const find = (no: number | null) => versions.find((v) => v.versionNo === no) ?? null;
    const draft = find(agent.draftVersion);
    const published = find(agent.publishedVersion);

    return {
      ...toSummary(agent, numbers),
      draft: draft ? toVersionDetail(draft, agent) : null,
      published: published ? toVersionDetail(published, agent) : null,
    };
  }

  async listVersions(ctx: WorkspaceContext, agentId: string): Promise<AgentVersionSummary[]> {
    const { agent, rows } = await withWorkspace(ctx, async (db) => {
      const agent = await this.loadAgent(db, ctx, agentId);
      const rows = await db.agentVersion.findMany({
        where: { agentId },
        orderBy: { versionNo: 'desc' },
      });
      return { agent, rows };
    });
    return rows.map((row) => toVersionSummary(row, agent));
  }

  async getVersion(
    ctx: WorkspaceContext,
    agentId: string,
    versionNo: number,
  ): Promise<AgentVersionDetail> {
    const { agent, row } = await withWorkspace(ctx, async (db) => {
      const agent = await this.loadAgent(db, ctx, agentId);
      const row = await db.agentVersion.findUnique({
        where: { agentId_versionNo: { agentId, versionNo } },
      });
      if (!row) throw AppError.notFound(`Version ${versionNo}`);
      return { agent, row };
    });
    return toVersionDetail(row, agent);
  }

  // ------------------------------------------------------------------ draft (W2, W3, D3)

  /**
   * PATCH /agents/:id/draft — the wizard's autosave and the D3 Brief/Voice tabs.
   *
   * Three kinds of field, three destinations:
   *
   *   - `name`, `industry`        labels; written to `agents` now. A name shows up in
   *                               `num:{e164}`, so the runtime cache is refreshed.
   *   - `brief`, `analysis_fields` the version's content.
   *   - everything else           `agentSettings` — tier, voice, languages, duration,
   *                               recording — also the version's content. **Not** written
   *                               to `agents`: those columns are live and bill.
   *
   * Content goes to the draft version — or, when that version is frozen (published, or
   * overtaken by a newer one), to a fresh version forked from it, so an edit after a
   * publish never rewrites what is live.
   */
  async patchDraft(
    ctx: WorkspaceContext,
    agentId: string,
    patch: AgentDraftPatch,
  ): Promise<AgentDetail> {
    const stack = await this.stack.current();
    const settingsPatch = settingsPatchOf(patch);
    const touchesVersion =
      patch.brief !== undefined ||
      patch.analysis_fields !== undefined ||
      Object.keys(settingsPatch).length > 0;

    const renamed = await withWorkspace(ctx, async (db) => {
      const agent = await this.loadAgent(db, ctx, agentId);

      const agentData: Prisma.AgentUncheckedUpdateInput = {};
      if (patch.name !== undefined) agentData.name = patch.name.trim();
      if (patch.industry !== undefined) agentData.industry = patch.industry;

      if (settingsPatch.voice_id !== undefined && settingsPatch.voice_id !== null) {
        // `agents.voice_id` is a foreign key into the cached catalogue, and a publish will
        // copy this value there. An id that is not in `voices` would be a constraint
        // violation and a 500 at publish time; the customer picked it from `GET /voices`,
        // so "we do not have that voice" is the honest answer now — and the one W3 can act
        // on by re-filtering the list.
        const voice = await db.voice.findUnique({
          where: { retellVoiceId: settingsPatch.voice_id },
          select: { retellVoiceId: true },
        });
        if (!voice) {
          throw new AppError('BAD_REQUEST', 'We do not have that voice. Pick one from the list.', [
            { field: 'voice_id', message: 'Unknown voice' },
          ]);
        }
      }

      if (Object.keys(agentData).length > 0) {
        await db.agent.update({ where: { id: agentId }, data: agentData });
      }
      if (!touchesVersion) return patch.name !== undefined;

      const draft = await this.loadDraftForWrite(db, agent);
      const merged = patch.brief
        ? mergeBrief(parseBrief(draft.briefJson), patch.brief)
        : parseBrief(draft.briefJson);
      const fields = patch.analysis_fields ?? parseAnalysisFields(draft.analysisSchemaJson);
      const settings = mergeSettings(settingsOf(draft, agent), settingsPatch);

      // The brief changed, so the prompt that was generated from it is stale. It is kept
      // (the customer may still test the version) but re-linted against the new brief, so
      // "a transfer number with no hand-off rule" appears the moment it becomes true.
      const lint = draft.promptText
        ? lintPrompt(
            {
              prompt: draft.promptText,
              greeting: draft.greeting,
              brief: merged,
              primaryLanguage: settings.primary_language,
            },
            stack.lint,
          )
        : null;

      if (draft.frozen) {
        await this.appendVersion(db, {
          agentId,
          source: 'manual',
          brief: merged,
          promptText: draft.promptText,
          greeting: draft.greeting,
          closing: draft.closing,
          analysisFields: fields,
          settings,
          briefCard: draft.briefCardJson,
          scenarios: draft.scenariosJson,
          lint,
          createdBy: ctx.userId,
        });
      } else {
        await db.agentVersion.update({
          where: { agentId_versionNo: { agentId, versionNo: draft.versionNo } },
          data: {
            briefJson: merged as unknown as Prisma.InputJsonValue,
            analysisSchemaJson: fields as unknown as Prisma.InputJsonValue,
            settingsJson: settings as unknown as Prisma.InputJsonValue,
            ...(lint ? { lintJson: lint as unknown as Prisma.InputJsonValue } : {}),
          },
        });
      }
      return patch.name !== undefined;
    });

    if (renamed) {
      // The only live field this route writes. `agent_name` rides in `num:{e164}`
      // (CLAUDE.md: refresh from every mutating path). Never allowed to fail the save.
      await this.runtimeCache
        .refresh(ctx.workspaceId)
        .catch((error: unknown) =>
          this.log.warn(`runtime-cache refresh after rename failed: ${message(error)}`),
        );
    }

    await this.events.publish(
      ctx.workspaceId,
      AgentEvents.topic(agentId),
      AgentEvents.draftUpdated,
      {
        agent_id: agentId,
      },
    );
    return this.get(ctx, agentId);
  }

  /**
   * PUT /agents/:id/versions/:v/prompt — the Advanced editor's "Save as new version"
   * (D3 Brief tab), source `manual`.
   *
   * The submitted text is the *body*: whatever guardrail block it contains is stripped and
   * the canonical one appended (§9.4). There is no request shape through which a customer
   * can remove, reword or replace the platform rules, which is why this method takes the
   * prompt and never a "guardrails" field. The settings are the base version's, carried
   * forward unchanged.
   */
  /**
   * `POST /agents/:id/versions/:v/lint` — the same rules `saveManualPrompt` applies, on
   * the same text it would store (guardrails appended), against version `v`'s brief and
   * language. Nothing is written and nothing is published on the event stream.
   */
  async lintDraftPrompt(
    ctx: WorkspaceContext,
    agentId: string,
    baseVersionNo: number,
    body: LintRequest,
  ): Promise<LintResult> {
    const stack = await this.stack.current();
    const { base, agent } = await withWorkspace(ctx, async (db) => {
      const agent = await this.loadAgent(db, ctx, agentId);
      const base = await db.agentVersion.findUnique({
        where: { agentId_versionNo: { agentId, versionNo: baseVersionNo } },
      });
      if (!base) throw AppError.notFound(`Version ${baseVersionNo}`);
      return { base, agent };
    });
    const settings = settingsOf(base, agent);
    const prompt = body.prompt.trim() ? applyGuardrails(body.prompt, stack.guardrails) : '';
    const greeting = body.greeting === undefined ? base.greeting : body.greeting;
    return lintPrompt(
      {
        prompt,
        greeting,
        brief: parseBrief(base.briefJson),
        primaryLanguage: settings.primary_language,
      },
      stack.lint,
    );
  }

  async saveManualPrompt(
    ctx: WorkspaceContext,
    agentId: string,
    baseVersionNo: number,
    update: PromptUpdate,
  ): Promise<AgentVersionDetail> {
    const stack = await this.stack.current();

    const versionNo = await withWorkspace(ctx, async (db) => {
      const agent = await this.loadAgent(db, ctx, agentId);
      const base = await db.agentVersion.findUnique({
        where: { agentId_versionNo: { agentId, versionNo: baseVersionNo } },
      });
      if (!base) throw AppError.notFound(`Version ${baseVersionNo}`);

      const briefValue = parseBrief(base.briefJson);
      const settings = settingsOf(base, agent);
      const promptText = applyGuardrails(update.prompt, stack.guardrails);
      const greeting = update.greeting ?? base.greeting;

      const lint = lintPrompt(
        {
          prompt: promptText,
          greeting,
          brief: briefValue,
          primaryLanguage: settings.primary_language,
        },
        stack.lint,
      );

      const versionNo = await this.appendVersion(db, {
        agentId,
        source: 'manual',
        brief: briefValue,
        promptText,
        greeting,
        closing: update.closing ?? base.closing,
        analysisFields: parseAnalysisFields(base.analysisSchemaJson),
        settings,
        briefCard: base.briefCardJson,
        scenarios: base.scenariosJson,
        lint,
        createdBy: ctx.userId,
      });

      await this.audit(db, ctx, 'agent.prompt_edited', agentId, {
        version_no: versionNo,
        base_version: baseVersionNo,
      });
      return versionNo;
    });

    await this.events.publish(
      ctx.workspaceId,
      AgentEvents.topic(agentId),
      AgentEvents.versionCreated,
      {
        agent_id: agentId,
        version_no: versionNo,
        source: 'manual',
      },
    );
    this.log.log(`agent ${agentId}: manual version ${versionNo} from ${baseVersionNo}`);
    return this.getVersion(ctx, agentId, versionNo);
  }

  /**
   * POST /agents/:id/draft/select {version_no} — §13.5 Undo, and "Restore as draft" in D3.
   *
   * A pointer move and nothing else: no LLM call, no new row. The selected version stays
   * immutable — the database refuses a content write to anything but the newest version —
   * so a later autosave forks rather than rewriting the history the customer just came
   * back to.
   */
  async selectDraft(
    ctx: WorkspaceContext,
    agentId: string,
    versionNo: number,
  ): Promise<AgentDetail> {
    await withWorkspace(ctx, async (db) => {
      await this.loadAgent(db, ctx, agentId);
      const exists = await db.agentVersion.findUnique({
        where: { agentId_versionNo: { agentId, versionNo } },
        select: { versionNo: true },
      });
      if (!exists) throw AppError.notFound(`Version ${versionNo}`);

      await db.agent.update({ where: { id: agentId }, data: { draftVersion: versionNo } });
      await this.audit(db, ctx, 'agent.draft_selected', agentId, { version_no: versionNo });
    });

    await this.events.publish(
      ctx.workspaceId,
      AgentEvents.topic(agentId),
      AgentEvents.draftSelected,
      {
        agent_id: agentId,
        version_no: versionNo,
      },
    );
    return this.get(ctx, agentId);
  }

  // ------------------------------------------------------------------ helpers shared with prompting

  /** Everything a generation job needs, read in one transaction and then let go. */
  async generationContext(workspaceId: string, agentId: string) {
    return withWorkspace(workspaceId, async (db) => {
      const agent = await db.agent.findFirst({
        where: { id: agentId, tenantId: workspaceId, deletedAt: null },
      });
      if (!agent) throw AppError.notFound('Agent');
      const tenant = await db.tenant.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { name: true, timezone: true },
      });
      const versions = await db.agentVersion.findMany({
        where: { agentId },
        orderBy: { versionNo: 'desc' },
        take: 20,
      });
      return { agent, tenant, versions };
    });
  }

  /**
   * Appends a version inside an existing transaction and points the agent's draft at it.
   * The `(agent_id, version_no)` unique key is what makes two concurrent writers safe:
   * the loser gets a unique violation rather than silently overwriting.
   */
  async appendVersion(
    db: WorkspaceDb | Prisma.TransactionClient,
    input: {
      agentId: string;
      source: VersionSource;
      brief: Brief;
      promptText: string | null;
      greeting: string | null;
      closing: string | null;
      analysisFields: AnalysisField[];
      settings: AgentSettings;
      briefCard?: unknown;
      scenarios?: unknown;
      changes?: string[] | null;
      feedbackText?: string | null;
      lint: LintResult | null;
      createdBy: string | null;
      stackVersion?: number;
    },
  ): Promise<number> {
    const latest = await db.agentVersion.aggregate({
      where: { agentId: input.agentId },
      _max: { versionNo: true },
    });
    const versionNo = (latest._max.versionNo ?? 0) + 1;

    await db.agentVersion.create({
      data: {
        agentId: input.agentId,
        versionNo,
        source: input.source,
        briefJson: input.brief as unknown as Prisma.InputJsonValue,
        promptText: input.promptText,
        greeting: input.greeting,
        closing: input.closing,
        analysisSchemaJson: input.analysisFields as unknown as Prisma.InputJsonValue,
        settingsJson: input.settings as unknown as Prisma.InputJsonValue,
        briefCardJson: (input.briefCard ?? undefined) as Prisma.InputJsonValue | undefined,
        scenariosJson: (input.scenarios ?? undefined) as Prisma.InputJsonValue | undefined,
        changesJson: (input.changes ?? undefined) as Prisma.InputJsonValue | undefined,
        feedbackText: input.feedbackText ?? null,
        lintJson: (input.lint ?? undefined) as unknown as Prisma.InputJsonValue | undefined,
        stackVersion: input.stackVersion,
        createdBy: input.createdBy,
      },
    });

    await db.agent.update({ where: { id: input.agentId }, data: { draftVersion: versionNo } });
    return versionNo;
  }

  /** An `audit_log` row. Append-only in Postgres; never updated, never deleted (§6.2). */
  async audit(
    db: WorkspaceDb | Prisma.TransactionClient,
    ctx: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
    action: string,
    targetId: string,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    await db.auditLog.create({
      data: {
        tenantId: ctx.workspaceId,
        actorUserId: ctx.userId,
        action,
        targetType: 'agent',
        targetId,
        metaJson: meta as Prisma.InputJsonValue,
      },
    });
  }

  private async agentCount(ctx: WorkspaceContext): Promise<number> {
    return withWorkspace(ctx, (db) =>
      db.agent.count({ where: { tenantId: ctx.workspaceId, deletedAt: null } }),
    );
  }

  /**
   * The agent, or a 404. Scoped by `tenantId` **and** run under RLS: the explicit filter
   * is what stops an id from another workspace becoming a 500 from a null dereference,
   * and RLS is what stops it being readable at all.
   */
  private async loadAgent(db: WorkspaceDb, ctx: WorkspaceContext, agentId: string) {
    const agent = await db.agent.findFirst({
      where: { id: agentId, tenantId: ctx.workspaceId, deletedAt: null },
    });
    if (!agent) throw AppError.notFound('Agent');
    return agent;
  }

  /**
   * The version an autosave should write to, and whether it is frozen.
   *
   * Frozen means published, or no longer the newest — the same two conditions the
   * `agent_versions_immutable` trigger enforces, expressed here so the service forks
   * deliberately instead of catching a database error.
   */
  private async loadDraftForWrite(
    db: WorkspaceDb,
    agent: { id: string; draftVersion: number | null },
  ) {
    const [draft, latest] = await Promise.all([
      agent.draftVersion
        ? db.agentVersion.findUnique({
            where: { agentId_versionNo: { agentId: agent.id, versionNo: agent.draftVersion } },
          })
        : Promise.resolve(null),
      db.agentVersion.aggregate({ where: { agentId: agent.id }, _max: { versionNo: true } }),
    ]);

    if (!draft) {
      // An agent always has a v1 (created in the same transaction as the agent), so this
      // is a pointer at a version that never existed — repair by pointing at the newest.
      const newest = await db.agentVersion.findFirst({
        where: { agentId: agent.id },
        orderBy: { versionNo: 'desc' },
      });
      if (!newest) throw AppError.notFound('Draft version');
      return { ...newest, frozen: newest.publishedAt !== null };
    }

    const frozen =
      draft.publishedAt !== null || draft.versionNo !== (latest._max.versionNo ?? draft.versionNo);
    return { ...draft, frozen };
  }
}

// ---------------------------------------------------------------------------
// Settings: the version's copy and the live copy
// ---------------------------------------------------------------------------

/** The live columns on `agents` a version's settings map onto. */
export interface LiveSettingsColumns {
  tier: string;
  primaryLanguage: string;
  languages: string[];
  voiceId: string | null;
  voiceSpeed: Prisma.Decimal | null;
  voiceTemperature: Prisma.Decimal | null;
  maxCallDurationS: number;
  recordingEnabled: boolean;
}

/**
 * A version's settings. `settings_json` when the row has one; for a row written before
 * the column existed, the agent's own columns — which is exactly what those rows meant.
 */
export function settingsOf(
  row: { settingsJson: unknown },
  agent: LiveSettingsColumns,
): AgentSettings {
  const parsed = agentSettingsSchema.safeParse(row.settingsJson);
  if (parsed.success) return parsed.data;
  return liveSettingsOf(agent);
}

/** The live settings, read back from the `agents` columns a publish wrote. */
export function liveSettingsOf(agent: LiveSettingsColumns): AgentSettings {
  const raw = {
    tier: agent.tier,
    primary_language: agent.primaryLanguage,
    languages: agent.languages,
    voice_id: agent.voiceId,
    voice_speed: agent.voiceSpeed === null ? null : Number(agent.voiceSpeed),
    voice_temperature: agent.voiceTemperature === null ? null : Number(agent.voiceTemperature),
    max_call_duration_s: agent.maxCallDurationS,
    recording_enabled: agent.recordingEnabled,
  };
  const parsed = agentSettingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // The columns carry defaults and no check constraints where the schema has ranges (an
  // old row could hold a 60 s ceiling). Keep what is valid, clamp the rest, never fail a
  // read over it.
  const defaults = defaultAgentSettings(agent.tier === 'premium' ? 'premium' : 'standard');
  const repaired = agentSettingsSchema.safeParse({
    ...defaults,
    voice_id: raw.voice_id,
    // `primary_language` is a plain column with no check constraint, and the schema now
    // holds it to Retell's locale list. Keep it when it is one, fall back to the default
    // when it is not, rather than throwing away the voice and the ceiling as well.
    primary_language: retellLanguage.safeParse(raw.primary_language).success
      ? raw.primary_language
      : defaults.primary_language,
    languages: raw.languages.filter((code) => retellLanguage.safeParse(code).success).slice(0, 4),
    max_call_duration_s: Math.min(
      1_800,
      Math.max(180, raw.max_call_duration_s || defaults.max_call_duration_s),
    ),
    recording_enabled: raw.recording_enabled,
  });
  return repaired.success ? repaired.data : defaults;
}

/**
 * The `agents` columns a publish writes from a version's settings. This is the **only**
 * path from a customer's choice of tier, voice or duration to the live row
 * (`AgentPublishService.publish`), and therefore the only path to the billing rate.
 */
export function liveColumnsFrom(
  settings: AgentSettings,
): Pick<
  Prisma.AgentUncheckedCreateInput,
  | 'tier'
  | 'primaryLanguage'
  | 'languages'
  | 'voiceId'
  | 'voiceSpeed'
  | 'voiceTemperature'
  | 'maxCallDurationS'
  | 'recordingEnabled'
> {
  return {
    tier: settings.tier,
    primaryLanguage: settings.primary_language,
    languages: settings.languages,
    voiceId: settings.voice_id,
    voiceSpeed: settings.voice_speed === null ? null : new Prisma.Decimal(settings.voice_speed),
    voiceTemperature:
      settings.voice_temperature === null ? null : new Prisma.Decimal(settings.voice_temperature),
    maxCallDurationS: settings.max_call_duration_s,
    recordingEnabled: settings.recording_enabled,
  };
}

/** The settings fields of a draft patch, and nothing else. `undefined` means "not sent". */
export function settingsPatchOf(patch: AgentDraftPatch): Partial<AgentSettings> {
  const out: Partial<AgentSettings> = {};
  if (patch.tier !== undefined) out.tier = patch.tier;
  if (patch.primary_language !== undefined) out.primary_language = patch.primary_language;
  if (patch.languages !== undefined) out.languages = patch.languages;
  if (patch.voice_id !== undefined) out.voice_id = patch.voice_id;
  if (patch.voice_speed !== undefined) out.voice_speed = patch.voice_speed;
  if (patch.voice_temperature !== undefined) out.voice_temperature = patch.voice_temperature;
  if (patch.max_call_duration_s !== undefined) out.max_call_duration_s = patch.max_call_duration_s;
  if (patch.recording_enabled !== undefined) out.recording_enabled = patch.recording_enabled;
  return out;
}

export function mergeSettings(
  current: AgentSettings,
  patch: Partial<AgentSettings>,
): AgentSettings {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  return agentSettingsSchema.parse(merged);
}

// ---------------------------------------------------------------------------
// Row → response
// ---------------------------------------------------------------------------

type AgentRow = LiveSettingsColumns & {
  id: string;
  name: string;
  templateId: string | null;
  industry: string | null;
  status: string;
  draftVersion: number | null;
  publishedVersion: number | null;
  createdAt: Date;
};

/** The live values: what is on the phone and what a call bills at (see `agentSummary`). */
export function toSummary(agent: AgentRow, numbersAttached: number): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    template_id: agent.templateId as AgentSummary['template_id'],
    industry: agent.industry,
    status: agent.status as AgentSummary['status'],
    tier: agent.tier as AgentSummary['tier'],
    primary_language: agent.primaryLanguage,
    languages: agent.languages,
    voice_id: agent.voiceId,
    draft_version: agent.draftVersion,
    published_version: agent.publishedVersion,
    has_unpublished_changes:
      agent.draftVersion !== null && agent.draftVersion !== agent.publishedVersion,
    numbers_attached: numbersAttached,
    max_call_duration_s: agent.maxCallDurationS,
    recording_enabled: agent.recordingEnabled,
    created_at: agent.createdAt.toISOString(),
  };
}

type VersionRow = {
  versionNo: number;
  source: string;
  briefJson: unknown;
  promptText: string | null;
  greeting: string | null;
  closing: string | null;
  analysisSchemaJson: unknown;
  briefCardJson: unknown;
  scenariosJson: unknown;
  changesJson: unknown;
  feedbackText: string | null;
  lintJson: unknown;
  settingsJson: unknown;
  createdBy: string | null;
  publishedAt: Date | null;
  createdAt: Date;
};

export function toVersionSummary(
  row: VersionRow,
  agent: { draftVersion: number | null; publishedVersion: number | null },
): AgentVersionSummary {
  return {
    version_no: row.versionNo,
    source: row.source as AgentVersionSummary['source'],
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    published_at: row.publishedAt?.toISOString() ?? null,
    is_published: agent.publishedVersion === row.versionNo,
    is_draft: agent.draftVersion === row.versionNo,
    changes: Array.isArray(row.changesJson) ? (row.changesJson as string[]) : null,
    has_prompt: Boolean(row.promptText),
  };
}

/**
 * `editable_prompt` is the whole point of the split: the Advanced editor gets the body,
 * `prompt_text` shows what Retell actually runs. A client that PUTs the editable text
 * back gets the guardrails re-appended, so the round trip cannot lose them.
 *
 * Nothing here names the provider: which Retell version a row was published as is
 * bookkeeping on the row, not part of what a customer sees.
 */
export function toVersionDetail(
  row: VersionRow,
  agent: LiveSettingsColumns & { draftVersion: number | null; publishedVersion: number | null },
): AgentVersionDetail {
  return {
    ...toVersionSummary(row, agent),
    brief: parseBrief(row.briefJson),
    prompt_text: row.promptText,
    editable_prompt: row.promptText ? stripGuardrails(row.promptText) : null,
    greeting: row.greeting,
    closing: row.closing,
    brief_card: briefCardSchema.safeParse(row.briefCardJson).data ?? null,
    scenarios: parseScenarios(row.scenariosJson),
    analysis_fields: row.analysisSchemaJson ? parseAnalysisFields(row.analysisSchemaJson) : null,
    feedback_text: row.feedbackText,
    lint: lintResultSchema.safeParse(row.lintJson).data ?? null,
    settings: settingsOf(row, agent),
  };
}

/**
 * A stored brief that no longer matches the schema — an older shape, a field we tightened,
 * or a newer shape read by a process that has not been redeployed yet — must not make the
 * agent unreadable, and must not cost the customer the rest of their brief.
 *
 * So the repair is per field, and per entry for `documents`: whatever fails is dropped and
 * everything else is kept. This used to fall back to an *empty* brief on any failure, and
 * on 29 Sep a worker started before the image document types existed read one
 * `image/jpeg` document as invalid, got `{}`, generated a script from nothing and stored
 * it as a new version with an empty brief (ADR 0023). An array field loses only its bad
 * entries; a field that still fails is dropped; `{}` is the last resort for input that is
 * not an object at all.
 */
export function parseBrief(value: unknown): Brief {
  const whole = briefSchema.safeParse(value ?? {});
  if (whole.success) return whole.data;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return briefSchema.parse({});

  const repaired: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  if (Array.isArray(repaired.documents)) {
    repaired.documents = repaired.documents.filter((doc) => briefDocumentSchema.safeParse(doc).success);
  }
  for (let pass = 0; pass < 3; pass++) {
    const attempt = briefSchema.safeParse(repaired);
    if (attempt.success) return attempt.data;
    for (const issue of attempt.error.issues) delete repaired[String(issue.path[0])];
  }
  return briefSchema.parse({});
}

/**
 * Per entry, not per array, and deliberately so.
 *
 * `analysisField` got stricter (an enum field must carry non-empty choices), and this
 * function is on every read path including publish. A whole-array parse would mean one
 * unparseable legacy field silently costing a version *all fifteen* of its analysis
 * fields — the agent would publish and quietly stop capturing anything. Filtering per
 * entry keeps the fourteen good ones and drops the one that cannot be sent, which is the
 * same thing `parseScenarios` below does and the same thing the §9.8 gate does on the
 * way in. Verified against the dev database before the schema was tightened: zero stored
 * fields fail it today, so this is a guard, not a migration.
 */
export function parseAnalysisFields(value: unknown): AnalysisField[] {
  if (!Array.isArray(value)) return [];
  const parsed = value.map((entry) => analysisField.safeParse(entry)).filter((r) => r.success);
  return parsed.map((r) => r.data!).slice(0, 15);
}

function parseScenarios(value: unknown): Scenario[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map((entry) => scenarioSchema.safeParse(entry)).filter((r) => r.success);
  return parsed.map((r) => r.data!);
}

/**
 * Field-by-field merge. An autosave sends the field that changed, so a `PATCH` carrying
 * `{about_business}` must not blank the twelve fields it did not mention. `undefined`
 * means "not sent"; `null` is not accepted by the schema, so there is no ambiguity.
 */
export function mergeBrief(current: Brief, patch: Partial<Brief>): Brief {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  return briefSchema.parse(merged);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
