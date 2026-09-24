import { Injectable, Logger } from '@nestjs/common';
import { withWorkspace } from '@portal/db';
import { AgentRetellService } from './agent-retell.service';
import { AgentStackService } from './agent-stack.service';
import { parseAnalysisFields, parseBrief, settingsOf } from './agents.service';

export type DraftSyncOutcome =
  | { status: 'ok'; retellAgentId: string; retellAgentVersion: number }
  | { status: 'skipped'; reason: 'no_prompt' | 'stack_missing' };

/**
 * Makes the platform's draft match one `agent_versions` row — prompt, greeting, brief
 * variables, analysis fields and the *version's* settings (tier stack, voice, languages,
 * ceiling) — and records the platform version number on the row.
 *
 * Two callers: the generation worker after writing a version (§13.3 step 6), and the
 * browser test call before minting (§13.4), because W3's voice and language edits are
 * saved onto the draft without a platform round trip and a test call must ring what the
 * customer built, not what the last generation left behind (D9 wizard run).
 *
 * Network I/O happens between two short `withWorkspace` blocks, never inside one.
 * Throws what the gateway throws; the callers decide whether that is fatal.
 */
@Injectable()
export class AgentDraftSyncService {
  private readonly log = new Logger(AgentDraftSyncService.name);

  constructor(
    private readonly retell: AgentRetellService,
    private readonly stack: AgentStackService,
  ) {}

  async syncVersion(workspaceId: string, agentId: string, versionNo: number): Promise<DraftSyncOutcome> {
    const stack = await this.stack.current();
    const snapshot = await withWorkspace(workspaceId, async (db) => {
      const agent = await db.agent.findFirstOrThrow({ where: { id: agentId, tenantId: workspaceId } });
      const version = await db.agentVersion.findUniqueOrThrow({ where: { agentId_versionNo: { agentId, versionNo } } });
      const tenant = await db.tenant.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, timezone: true } });
      return { agent, version, tenant };
    });

    if (!snapshot.version.promptText) return { status: 'skipped', reason: 'no_prompt' };

    const settings = settingsOf(snapshot.version, snapshot.agent);
    const tierStack = await this.stack.tierStack(settings.tier);
    if (!tierStack) {
      // No compiled-in stack to fall back to (CLAUDE.md, "Configuration"). The version is
      // stored; publish refuses loudly with NOT_CONFIGURED until SA6 is fixed.
      this.log.error(`agent ${agentId}: no ${settings.tier} stack in agent_stack_configs; draft not synced`);
      return { status: 'skipped', reason: 'stack_missing' };
    }

    const sync = await this.retell.syncDraft({
      agentId,
      agentName: snapshot.agent.name,
      retellAgentId: snapshot.agent.retellAgentId,
      retellLlmId: snapshot.agent.retellLlmId,
      retellKbId: snapshot.agent.retellKbId,
      promptText: snapshot.version.promptText,
      greeting: snapshot.version.greeting,
      brief: parseBrief(snapshot.version.briefJson),
      analysisFields: parseAnalysisFields(snapshot.version.analysisSchemaJson),
      voiceId: settings.voice_id,
      voiceSpeed: settings.voice_speed,
      voiceTemperature: settings.voice_temperature,
      primaryLanguage: settings.primary_language,
      languages: settings.languages,
      maxCallDurationS: settings.max_call_duration_s,
      timezone: snapshot.tenant.timezone,
      businessName: snapshot.tenant.name,
      stack: tierStack,
      guardrails: stack.guardrails,
    });

    await withWorkspace(workspaceId, async (db) => {
      await db.agent.update({ where: { id: agentId }, data: { retellAgentId: sync.agentId, retellLlmId: sync.llmId } });
      await db.agentVersion.update({ where: { agentId_versionNo: { agentId, versionNo } }, data: { retellAgentVersion: sync.draftVersion } });
    });
    return { status: 'ok', retellAgentId: sync.agentId, retellAgentVersion: sync.draftVersion };
  }
}
