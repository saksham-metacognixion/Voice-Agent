import { describe, expect, it } from 'vitest';
import type { RetellGateway, TierStack } from '../retell';
import { AgentRetellService, toRetellAnalysisFields, type RetellSyncInput } from './agent-retell.service';

/*
 * D5 review finding 8: no compiled-in model, voice or plan ceiling. The tier stack is
 * required, every Retell-bound value comes from it, and a missing one fails loudly.
 */

const stack: TierStack = {
  model: 'model-from-sa6',
  default_voice_id: '11labs-voice-from-sa6',
  voice_model: 'eleven_multilingual_v2',
  max_call_duration_ms: 900_000,
};

function gateway(published = false) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      if (method === 'createLlm') return { llm_id: 'llm_1' };
      if (method === 'createAgent') return { agent_id: 'agent_1', version: 0 };
      if (method === 'getAgent') return { agent_id: 'agent_1', version: published ? 3 : 3, is_published: published };
      if (method === 'createAgentVersion') return { agent_id: 'agent_1', version: 4 };
      return {};
    };
  const fake = {
    calls,
    createLlm: record('createLlm'),
    updateLlm: record('updateLlm'),
    createAgent: record('createAgent'),
    updateAgent: record('updateAgent'),
    getAgent: record('getAgent'),
    createAgentVersion: record('createAgentVersion'),
    publishAgent: record('publishAgent'),
    deleteAgent: record('deleteAgent'),
    deleteLlm: record('deleteLlm'),
  };
  return fake as unknown as RetellGateway & { calls: typeof calls };
}

function input(over: Partial<RetellSyncInput> = {}): RetellSyncInput {
  return {
    agentId: '11111111-1111-4111-8111-111111111111',
    agentName: 'Sophie',
    retellAgentId: null,
    retellLlmId: null,
    retellKbId: null,
    promptText:
      'You are Sophie, the receptionist. Greet the caller and take a message for the team.',
    greeting: 'Hello',
    brief: { services: [], faqs: [], handoff_rules: [], ai_disclosure: 'if_asked' },
    analysisFields: [],
    voiceId: null,
    voiceSpeed: null,
    voiceTemperature: null,
    primaryLanguage: 'en-US',
    languages: [],
    maxCallDurationS: 1_500,
    timezone: 'America/Toronto',
    businessName: 'Maple Dental',
    stack,
    guardrails: ['Never claim to be human.'],
    ...over,
  };
}

describe('AgentRetellService.syncDraft', () => {
  it('refuses without a tier stack and sends nothing to Retell', async () => {
    const gw = gateway();
    const service = new AgentRetellService(gw);
    await expect(
      service.syncDraft(input({ stack: null as unknown as TierStack })),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(gw.calls).toEqual([]);
  });

  it('takes the model, the default voice and the plan ceiling from the stack, never from code', async () => {
    const gw = gateway();
    const service = new AgentRetellService(gw);
    await service.syncDraft(input());

    const llm = gw.calls.find((c) => c.method === 'createLlm')!.args[0] as { model: string };
    expect(llm.model).toBe('model-from-sa6');

    const agent = gw.calls.find((c) => c.method === 'createAgent')!.args[0] as {
      voiceId: string;
      voiceModel: string;
      maxCallDurationMs: number;
    };
    expect(agent.voiceId).toBe('11labs-voice-from-sa6');
    expect(agent.voiceModel).toBe('eleven_multilingual_v2');
    // min(agent 1500 s, plan 900 s) — the plan ceiling is configuration.
    expect(agent.maxCallDurationMs).toBe(900_000);
  });

  it("sends the tier's TTS model only with a voice of its provider (a Cartesia voice gets its own default)", async () => {
    const gw = gateway();
    await new AgentRetellService(gw).syncDraft({ ...input(), voiceId: 'cartesia-Adrian' });
    const agent = gw.calls.find((c) => c.method === 'createAgent')!.args[0] as { voiceId: string; voiceModel?: string | null };
    expect(agent.voiceId).toBe('cartesia-Adrian');
    expect(agent.voiceModel).toBeNull();
  });

  it('prefers the version’s own voice and ceiling when they are within the plan', async () => {
    const gw = gateway();
    const service = new AgentRetellService(gw);
    await service.syncDraft(input({ voiceId: 'cartesia-Cleo', maxCallDurationS: 600 }));
    const agent = gw.calls.find((c) => c.method === 'createAgent')!.args[0] as {
      voiceId: string;
      maxCallDurationMs: number;
    };
    expect(agent).toMatchObject({ voiceId: 'cartesia-Cleo', maxCallDurationMs: 600_000 });
  });
});

describe('toRetellAnalysisFields', () => {
  it('maps our types onto Retell’s, including enum choices', () => {
    expect(
      toRetellAnalysisFields([
        { name: 'reason', type: 'text', description: 'Why they rang.' },
        { name: 'urgency', type: 'enum', description: 'How urgent.', enum: ['low', 'high'] },
        { name: 'party_size', type: 'number', description: 'How many.' },
        { name: 'callback', type: 'boolean', description: 'Wants a call back.' },
      ]),
    ).toEqual([
      { type: 'string', name: 'reason', description: 'Why they rang.' },
      { type: 'enum', name: 'urgency', description: 'How urgent.', choices: ['low', 'high'] },
      { type: 'number', name: 'party_size', description: 'How many.' },
      { type: 'boolean', name: 'callback', description: 'Wants a call back.' },
    ]);
  });

  /*
   * The regression this change exists for: `choices: field.enum ?? []` used to
   * manufacture the one array shape Retell documents as illegal ("must be non empty
   * array"), and an `as unknown as` cast at the call site hid it from the compiler.
   * `analysisField` now makes that input unrepresentable, so the fallback has no reason
   * to exist — this asserts it is gone.
   */
  it('never emits an empty choices array', () => {
    const mapped = toRetellAnalysisFields([
      { name: 'urgency', type: 'enum', description: 'How urgent.', enum: ['low'] },
    ]);
    for (const field of mapped) {
      if (field.type === 'enum') expect(field.choices.length).toBeGreaterThan(0);
    }
  });

  it('carries no choices key on a non-enum field', () => {
    const [mapped] = toRetellAnalysisFields([{ name: 'reason', type: 'text', description: 'Why.' }]);
    expect(mapped && 'choices' in mapped).toBe(false);
  });
});

/*
 * The order `syncDraft` calls Retell in, which is not cosmetic.
 *
 * The Retell LLM is versioned with the agent (`response_engine.version`), so while the
 * latest agent version is published the LLM is too, and `update-retell-llm` answers
 * 400 "Cannot update published LLM". ADR 0003 §7 wrote the order down —
 * `create-agent-version` → `update-retell-llm` → `update-agent` — and the implementation
 * had the first two the other way round, so **every republish of a published agent
 * failed**. Confirmed against the live API on 17 Sep (`scripts/d5-retell-verify.ts`).
 */
describe('AgentRetellService.syncDraft ordering (ADR 0003 §7)', () => {
  it('branches the published version before touching the LLM', async () => {
    const gw = gateway(true);
    const service = new AgentRetellService(gw);
    const result = await service.syncDraft(
      input({ retellAgentId: 'agent_1', retellLlmId: 'llm_1' }),
    );

    const order = gw.calls.map((c) => c.method);
    expect(order).toEqual(['getAgent', 'createAgentVersion', 'updateLlm', 'updateAgent']);
    expect(order.indexOf('createAgentVersion')).toBeLessThan(order.indexOf('updateLlm'));
    expect(result.draftVersion).toBe(4);
  });

  it('skips the branch when the latest version is already a draft, and still edits the LLM', async () => {
    const gw = gateway(false);
    const service = new AgentRetellService(gw);
    await service.syncDraft(input({ retellAgentId: 'agent_1', retellLlmId: 'llm_1' }));
    expect(gw.calls.map((c) => c.method)).toEqual(['getAgent', 'updateLlm', 'updateAgent']);
  });

  it('does not update an LLM it just created', async () => {
    const gw = gateway();
    const service = new AgentRetellService(gw);
    await service.syncDraft(input());
    expect(gw.calls.map((c) => c.method)).toEqual(['createLlm', 'createAgent']);
  });
});

/*
 * W3 offers a language picker and two voice dials. Both were reaching the database and
 * neither was reaching Retell: `language: "multi"` expands to a fixed ten that excludes
 * fr-CA, and voice speed/temperature were simply never sent.
 *
 * §W3's text says `multi`; ADR 0003 §6 is the decision to send the array instead, and
 * these tests pin that decision on purpose (reviewed 21 Sep 2026). Flipping the branch
 * in `agentSpec` must fail here first.
 */
describe('AgentRetellService: what W3 promises actually reaches Retell', () => {
  it('sends the customer’s own locales, not Retell’s fixed `multi` set', async () => {
    const gw = gateway();
    const service = new AgentRetellService(gw);
    await service.syncDraft(input({ primaryLanguage: 'fr-CA', languages: ['en-US'] }));
    const agent = gw.calls.find((c) => c.method === 'createAgent')!.args[0] as { language: unknown };
    expect(agent.language).toEqual(['fr-CA', 'en-US']);
  });

  it('sends a plain locale when there is no also-speaks language', async () => {
    const gw = gateway();
    const service = new AgentRetellService(gw);
    await service.syncDraft(input({ primaryLanguage: 'fr-CA', languages: [] }));
    const agent = gw.calls.find((c) => c.method === 'createAgent')!.args[0] as { language: unknown };
    expect(agent.language).toBe('fr-CA');
  });

  it('never repeats the primary language in the list', async () => {
    const gw = gateway();
    const service = new AgentRetellService(gw);
    await service.syncDraft(input({ primaryLanguage: 'en-US', languages: ['en-US', 'fr-CA'] }));
    const agent = gw.calls.find((c) => c.method === 'createAgent')!.args[0] as { language: unknown };
    expect(agent.language).toEqual(['en-US', 'fr-CA']);
  });

  it('carries the voice dials through', async () => {
    const gw = gateway();
    const service = new AgentRetellService(gw);
    await service.syncDraft(input({ voiceSpeed: 1.05, voiceTemperature: 0.7 }));
    const agent = gw.calls.find((c) => c.method === 'createAgent')!.args[0] as Record<string, unknown>;
    expect(agent.voiceSpeed).toBe(1.05);
    expect(agent.voiceTemperature).toBe(0.7);
  });

  it('leaves the dials to Retell’s default when the customer has not set them', async () => {
    const gw = gateway();
    const service = new AgentRetellService(gw);
    await service.syncDraft(input());
    const agent = gw.calls.find((c) => c.method === 'createAgent')!.args[0] as Record<string, unknown>;
    expect(agent.voiceSpeed).toBeUndefined();
    expect(agent.voiceTemperature).toBeUndefined();
  });
});
