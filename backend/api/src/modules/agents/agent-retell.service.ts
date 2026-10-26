import { Injectable, Logger } from '@nestjs/common';
import { adminDb } from '@portal/db';
import type { AnalysisField, Brief, RetellLanguage } from '@portal/schemas';
import { isPhoneFieldName, transferTargets } from '@portal/schemas';
import { AppError } from '../../common/errors/app-error';
import { runtimePrompt } from '../prompting/documents';
import { redactTransferNumbers, transferRoutes } from '../prompting/staff-transfer';
import {
  RetellGateway,
  clampDuration,
  type AgentSpec,
  type LlmModel,
  type LlmSpec,
  type PostCallAnalysisField,
  type PostCallAnalysisModel,
  type TierStack,
  providerOfVoiceId,
  voiceModelFor,
} from '../retell';

/**
 * Projecting one `agent_versions` row onto Retell (§13.3 step 6, §13.6).
 *
 * Postgres is the source of truth and every Retell object is a projection of it
 * (architecture §8): nothing here reads Retell to decide product behaviour, only to find
 * out which version number to edit. The gateway is still the only thing that imports the
 * SDK — this file speaks in `LlmSpec` and `AgentSpec`.
 *
 * Both entry points are idempotent, because both are reached from a retried job:
 *   `syncDraft`   make the Retell draft match this version, creating objects if needed
 *   `publish`     publish that draft; a version Retell has already published is a no-op
 */
@Injectable()
export class AgentRetellService {
  private readonly log = new Logger(AgentRetellService.name);

  constructor(private readonly retell: RetellGateway) {}

  /**
   * Ensures the agent has Retell objects and that its *draft* version carries this
   * prompt. Returns the ids and the Retell version number the draft now occupies.
   *
   * The dance comes straight from ADR 0003 §7: a published Retell version is immutable
   * (`update-agent` answers 422), so when the latest version is published a new draft has
   * to be branched from it first. Doing it in that order means a publish never needs
   * `update-phone-number` — numbers are bound to `latest_published` once, at provisioning.
   */
  async syncDraft(input: RetellSyncInput): Promise<RetellSyncResult> {
    if (!input.stack) {
      // Belt and braces for a JavaScript caller: the type already forbids it.
      throw new AppError(
        'NOT_CONFIGURED',
        'The agent stack is not configured; nothing was sent to the voice platform.',
      );
    }
    const llmSpec = this.llmSpec(input);
    const voiceProvider = await this.voiceProvider(input.voiceId ?? input.stack.default_voice_id);
    let llmId = input.retellLlmId;
    let created = false;

    if (!llmId) {
      const llm = await this.retell.createLlm(llmSpec);
      llmId = llm.llm_id;
      created = true;
      this.log.log(`agent ${input.agentId}: created Retell LLM ${llmId}`);
    }

    if (!input.retellAgentId) {
      // No agent yet, so no published version can be holding the LLM: it is editable.
      // (Reachable when a previous sync created the LLM and then died.)
      if (!created) await this.retell.updateLlm(llmId, llmSpec);
      // `create-agent` makes version 0, unpublished, already carrying this content
      // (ADR 0003 §7). There is nothing left to update.
      const agent = await this.retell.createAgent(this.agentSpec(input, llmId, voiceProvider));
      this.log.log(
        `agent ${input.agentId}: created Retell agent ${agent.agent_id} (v${agent.version ?? 0})`,
      );
      return { llmId, agentId: agent.agent_id, draftVersion: agent.version ?? 0, created: true };
    }

    const agentId = input.retellAgentId;

    // Which Retell version are we allowed to edit? `get-agent` with no version returns the
    // latest one, which is the only one that can be a draft.
    const latest = await this.retell.getAgent(agentId);
    let draftVersion = latest.version ?? 0;

    if (latest.is_published) {
      const branched = await this.retell.createAgentVersion(agentId, draftVersion);
      draftVersion = branched.version ?? draftVersion + 1;
      this.log.log(
        `agent ${input.agentId}: branched Retell draft v${draftVersion} from the published v${latest.version}`,
      );
    }

    // **Order matters, and it is the order ADR 0003 §7 wrote down**:
    // `create-agent-version` → `update-retell-llm` → `update-agent`.
    //
    // The LLM is versioned *with* the agent (`response_engine.version`), so while the
    // latest agent version is published, so is the LLM version it points at, and
    // `update-retell-llm` answers **400 "Cannot update published LLM"**. Branching first
    // is what bumps `response_engine.version` and hands us an editable LLM again.
    //
    // This used to run first, which meant every republish of an already-published agent
    // failed — the whole edit-and-publish-again flow, not an edge case. `FakeRetellGateway`
    // models the agent's version immutability but not the LLM's, so nothing caught it
    // until the payload was sent to the real API
    // (`scripts/d5-retell-verify.ts`, fixtures `d5-*.json`).
    if (!created) await this.retell.updateLlm(llmId, llmSpec);
    await this.retell.updateAgent(agentId, this.agentSpec(input, llmId, voiceProvider));

    return { llmId, agentId, draftVersion, created };
  }

  /**
   * Publishes one Retell draft version. Idempotent: Retell refuses to publish a version
   * that is already published, and "it is already what we wanted" is a success, not a
   * failure — a retried publish job must not end with a red job and a live agent.
   */
  async publish(retellAgentId: string, version: number, title: string): Promise<void> {
    try {
      await this.retell.publishAgent(retellAgentId, version, title.slice(0, 60));
    } catch (error) {
      if (await this.alreadyPublished(retellAgentId, version)) {
        this.log.log(`agent ${retellAgentId} v${version} was already published; treating as done`);
        return;
      }
      throw error;
    }
  }

  /** Destroys the Retell objects behind a deleted agent. Never throws — see the caller. */
  async destroy(input: {
    retellAgentId: string | null;
    retellLlmId: string | null;
  }): Promise<string[]> {
    const failures: string[] = [];
    if (input.retellAgentId) {
      await this.retell.deleteAgent(input.retellAgentId).catch((error: unknown) => {
        failures.push(`agent ${input.retellAgentId}: ${message(error)}`);
      });
    }
    if (input.retellLlmId) {
      await this.retell.deleteLlm(input.retellLlmId).catch((error: unknown) => {
        failures.push(`llm ${input.retellLlmId}: ${message(error)}`);
      });
    }
    return failures;
  }

  private async alreadyPublished(retellAgentId: string, version: number): Promise<boolean> {
    try {
      const agent = await this.retell.getAgent(retellAgentId, version);
      return Boolean(agent.is_published);
    } catch {
      return false;
    }
  }

  private llmSpec(input: RetellSyncInput): LlmSpec {
    return {
      // Script, then the W2 documents verbatim, then the §9.4 block — the documents live
      // in the brief and are appended here, never stored in the prompt (ADR 0023). Belt
      // and braces on the guardrails: the stored prompt already carries them, and applying
      // them again is a no-op, so a row written by an older build still reaches Retell
      // with the platform rules attached.
      //
      // Transfer numbers are redacted from what the model reads and says — the script and
      // the greeting — and kept only as the transfer tools' destinations (BUG-005).
      prompt: runtimePrompt(input.promptText, input.brief, input.guardrails),
      beginMessage: input.greeting === null ? null : redactTransferNumbers(input.greeting, transferTargets(input.brief)),
      // `agent_stack_configs` is data, so its model id is a string here and a union in the
      // SDK. Retell rejects an id it does not know, which is the check that matters — a
      // typo in SA6 fails at the gateway with a clear message rather than at compile time.
      model: input.stack.model as LlmModel,
      knowledgeBaseIds: input.retellKbId ? [input.retellKbId] : undefined,
      defaultDynamicVariables: this.dynamicVariables(input),
      transfers: transferRoutes(input.brief),
    };
  }

  /**
   * The chosen voice's provider, from the catalogue (`voices.provider`, a global table),
   * else its id prefix. A catalogue that cannot be read never fails a sync over it.
   */
  private async voiceProvider(voiceId: string): Promise<string | null> {
    try {
      const row = await adminDb.voice.findUnique({
        where: { retellVoiceId: voiceId },
        select: { provider: true },
      });
      if (row?.provider) return row.provider;
    } catch {
      /* fall through to the prefix */
    }
    return providerOfVoiceId(voiceId);
  }

  private agentSpec(
    input: RetellSyncInput,
    llmId: string,
    voiceProvider: string | null,
  ): AgentSpec {
    // W3: no voice picked means the tier's default voice — a row in SA6, never a constant.
    const voiceId = input.voiceId ?? input.stack.default_voice_id;
    return {
      name: input.agentName,
      llmId,
      voiceId,
      // The tier's TTS model only fits voices of its own provider; any other voice runs
      // on its provider's default model rather than failing the sync with a 400.
      voiceModel: voiceModelFor(voiceProvider, input.stack.voice_model),
      // W3 offers both; they are stored on the version and were never sent, so the
      // customer's choice had no effect on the call. Null means "leave Retell's default".
      voiceSpeed: input.voiceSpeed ?? undefined,
      voiceTemperature: input.voiceTemperature ?? undefined,
      // W3 reads "if ≥ 1 also-speaks → Retell language: multi", and `multi` turns out
      // **not** to mean "the languages this agent speaks". Retell expands it to a fixed
      // ten — en-US, es-ES, fr-FR, de-DE, hi-IN, ru-RU, pt-PT, ja-JP, it-IT, nl-NL — which
      // does not contain fr-CA. A Quebec customer picking fr-CA plus English therefore got
      // an agent that could not speak their *primary* language, and picked up nine they
      // never asked for. Captured in `test/fixtures/retell/api/d5-create-agent.json`.
      //
      // The explicit array is the same call the D2 spike made and Retell stores it
      // verbatim (`create-agent.json`: `["en-US","fr-CA"]`), so this is what the W3 screen
      // actually promises. The scalar stays for the single-language case. ADR 0003 §6 is
      // the decision that overrides §W3's literal `multi` (reviewed again 21 Sep 2026);
      // if the spec owner wants the literal reading, this branch, the "what W3 promises"
      // tests and that ADR note change together.
      language:
        input.languages.length > 0
          ? [...new Set<RetellLanguage>([input.primaryLanguage, ...input.languages])]
          : input.primaryLanguage,
      maxCallDurationMs: this.maxDurationMs(input),
      postCallAnalysis: toRetellAnalysisFields(input.analysisFields),
      postCallAnalysisModel: input.stack.post_call_analysis_model as
        PostCallAnalysisModel | undefined,
      denoisingMode: input.stack.denoising_mode,
      sttMode: input.stack.stt_mode,
      timezone: input.timezone,
    };
  }

  /**
   * The agent's own ceiling, never above the plan's. This is the *agent* limit; the §13.9
   * inbound path lowers it again per call from the wallet, which is a different number and
   * a different place (ADR 0011 §1). The plan ceiling is the tier's
   * `max_call_duration_ms` from `agent_stack_configs` — configuration, not a constant.
   */
  private maxDurationMs(input: RetellSyncInput): number {
    return clampDuration(
      Math.min(input.maxCallDurationS * 1_000, input.stack.max_call_duration_ms),
    );
  }

  /**
   * §9.7 defaults. The inbound webhook overrides every one of these per call (§13.9), so
   * these are what a browser test call and a first ring see before that happens.
   */
  private dynamicVariables(input: RetellSyncInput): Record<string, string> {
    const variables: Record<string, string> = {
      business_name: input.businessName,
      agent_name: input.brief.agent_name ?? input.agentName,
      business_open: 'true',
      next_open_time: '',
      current_time: '',
    };
    transferTargets(input.brief).forEach((number, index) => {
      variables[`transfer_number_${index + 1}`] = number;
    });
    return variables;
  }
}

export interface RetellSyncInput {
  /** Our agent id, for logs only. */
  agentId: string;
  agentName: string;
  retellAgentId: string | null;
  retellLlmId: string | null;
  retellKbId: string | null;
  promptText: string;
  greeting: string | null;
  brief: Brief;
  analysisFields: AnalysisField[];
  voiceId: string | null;
  voiceSpeed: number | null;
  voiceTemperature: number | null;
  primaryLanguage: RetellLanguage;
  languages: RetellLanguage[];
  maxCallDurationS: number;
  timezone: string;
  businessName: string;
  /**
   * The tier's stack from `agent_stack_configs` (admin SA6): model, default voice, plan
   * ceiling. **Required.** There is no compiled-in model or voice to fall back to — a
   * publish on an environment whose stack row is missing or malformed must fail loudly
   * (`NOT_CONFIGURED`) rather than quietly run a Premium customer on a guessed model
   * (CLAUDE.md, "never hard-code a price, rate, cap or model id"). Callers get it from
   * `AgentStackService.tierStack()` and refuse when that is null.
   */
  stack: TierStack;
  guardrails: string[];
}

export interface RetellSyncResult {
  llmId: string;
  agentId: string;
  /** The Retell version number the draft now occupies — what `publish` is called with. */
  draftVersion: number;
  created: boolean;
}

/**
 * Retell's `post_call_analysis_data`, built from the version's analysis schema (§9.8).
 *
 * It lives here rather than in `prompting/` for two reasons: it is a Retell projection,
 * and the D5 arrow runs `prompting` → `agents` → `retell`, so the SDK-derived type it
 * returns belongs on this side of it.
 *
 * The return type is `PostCallAnalysisField[]` — the SDK's own union — so the compiler
 * checks the shape. It used to be `Array<Record<string, unknown>>` cast through
 * `unknown` at the call site, which switched off the only check that would have caught
 * `choices: []`: Retell documents an enum field's choices as "must be non empty array",
 * and `analysisField` now makes that unrepresentable rather than merely unlikely.
 */
export function toRetellAnalysisFields(fields: AnalysisField[]): PostCallAnalysisField[] {
  return fields.map((field) => {
    if (field.type === 'enum') {
      return {
        type: 'enum',
        name: field.name,
        description: field.description,
        choices: field.enum,
      };
    }
    return {
      type: field.type === 'text' ? 'string' : field.type,
      name: field.name,
      description: field.type === 'text' && isPhoneFieldName(field.name) ? `${field.description} ${PHONE_FIELD_RULE}` : field.description,
    };
  });
}

/**
 * Appended to every captured phone field, whoever wrote its description (a template, the
 * generation model, a customer): the analysis must copy the caller's digits, not the
 * agent's read-back — on 26 Oct the read-back was the one with an invented digit.
 * `captured-phones.ts` checks the result against the transcript either way.
 */
export const PHONE_FIELD_RULE =
  "Copy the digits exactly as the caller said them, in their order, from the caller's own words and not from the agent's read-back. Never add, drop or change a digit, even when the number looks incomplete.";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
