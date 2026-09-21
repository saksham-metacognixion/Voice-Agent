/**
 * Priority 2 of the D5 review: send the **real D5 publish payload** to the **real Retell
 * API** and keep what it answers.
 *
 *   pnpm --filter @portal/api verify:d5-retell
 *   pnpm --filter @portal/api verify:d5-retell --keep     # leave the objects behind
 *
 * Why this exists. `FakeRetellGateway` models Retell's version semantics faithfully — a
 * published version is immutable, so an edit branches — which is the hard part and the
 * part worth faking. What it cannot do is validate a payload, and the D2 spike only ever
 * sent a hand-written one. Everything D5 added on top of that (model-generated analysis
 * fields, `language: "multi"`, the voice dials, the stack's voice model, denoising, STT
 * and post-call-analysis model, transfer numbers, dynamic variables) had therefore never
 * met the endpoint. ADR 0012 records four bugs on the Anthropic side that only a real
 * call found, two of which would have meant nothing ever worked; this is the same check
 * on the Retell side.
 *
 * It goes through `AgentRetellService`, not the gateway directly, so what is verified is
 * the path publish actually takes. The tier stack is read from `agent_stack_configs`, so
 * the values under test are the ones the product ships, not invented ones.
 *
 * It creates and then deletes one Retell agent and one LLM. No phone number is bought, so
 * it costs nothing.
 */
import 'reflect-metadata';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { adminDb } from '@portal/db';
import { agentStackTiers, type TierStack } from '../src/modules/retell/retell.types';
import { RetellConfig } from '../src/modules/retell/retell.config';
import { RetellGateway } from '../src/modules/retell/retell.gateway';
import { AgentRetellService, type RetellSyncInput } from '../src/modules/agents/agent-retell.service';
import type { AnalysisField, Brief } from '@portal/schemas';

const FIXTURE_DIR = path.resolve(__dirname, '../test/fixtures/retell/api');

/** Every §9.8 type, including the enum that started all of this. */
const ANALYSIS_FIELDS: AnalysisField[] = [
  { name: 'caller_name', type: 'text', description: 'The caller’s name if they give it.' },
  { name: 'call_reason', type: 'enum', description: 'Why they rang.', enum: ['appointment', 'question', 'complaint'] },
  { name: 'party_size', type: 'number', description: 'How many people the booking is for.' },
  { name: 'callback_requested', type: 'boolean', description: 'True when they asked to be called back.' },
  { name: 'caller_intent', type: 'text', description: 'What the caller wanted, in one short phrase.' },
  { name: 'follow_up_required', type: 'boolean', description: 'True when a person still needs to act.' },
];

const BRIEF = {
  agent_name: 'Maya',
  about_business: 'A family dental clinic in Laval.',
  goal: 'Answer calls, share hours and take messages.',
  services: ['Check-ups', 'Cleanings'],
  faqs: [],
  handoff_rules: [
    { when: 'The caller has a dental emergency', action: 'transfer' as const, transfer_number: '+14168675309' },
    { when: 'The caller wants to speak to accounts', action: 'transfer' as const, transfer_number: '+15146875309' },
  ],
  ai_disclosure: 'if_asked' as const,
} as unknown as Brief;

const PROMPT = `You are Maya, the receptionist for a family dental clinic in Laval.
Greet the caller, find out whether they want to book, ask a question, or something else, and
take a clear message. Keep every reply under 25 words. When the caller says goodbye, end the call.`;

async function main() {
  const keep = process.argv.includes('--keep');
  const gw = new RetellGateway(new RetellConfig());
  gw.config.assertConfigured();
  const service = new AgentRetellService(gw);

  const stack = await tierStackFromDb('premium');
  console.log('tier stack (premium, from agent_stack_configs):', JSON.stringify(stack));

  const input: RetellSyncInput = {
    agentId: '00000000-0000-4000-8000-00000000d5d5',
    agentName: 'd5-verify',
    retellAgentId: null,
    retellLlmId: null,
    retellKbId: null,
    promptText: PROMPT,
    greeting: 'Thank you for calling {{business_name}}, this is {{agent_name}}. How can I help?',
    brief: BRIEF,
    analysisFields: ANALYSIS_FIELDS,
    voiceId: null, // exercise the stack default
    voiceSpeed: 1.05,
    voiceTemperature: 0.7,
    primaryLanguage: 'fr-CA',
    languages: ['en-US'], // ≥ 1 also-speaks ⇒ language: "multi" (W3)
    maxCallDurationS: 900,
    timezone: 'America/Toronto',
    businessName: 'Maple Dental',
    stack,
    guardrails: ['Never claim to be human. If asked, say you are an AI assistant.'],
  };

  let agentId: string | null = null;
  let llmId: string | null = null;

  try {
    console.log('\n--- syncDraft (create-retell-llm + create-agent) ---');
    const syncStarted = Date.now();
    const sync = await service.syncDraft(input);
    agentId = sync.agentId;
    llmId = sync.llmId;
    console.log(`created agent ${sync.agentId} llm ${sync.llmId} draft v${sync.draftVersion} in ${Date.now() - syncStarted} ms`);

    const created = await gw.getAgent(sync.agentId);
    await fixture('d5-create-agent', created);
    report(created);

    // The LLM object carries the §11 transfer targets and the §9.7 dynamic variables.
    const llm = await gw.client.llm.retrieve(sync.llmId);
    await fixture('d5-create-retell-llm', llm);
    const llmRow = llm as unknown as Record<string, unknown>;
    console.log('  what Retell stored on the LLM:');
    for (const k of ['model', 'begin_message', 'default_dynamic_variables', 'general_tools', 'knowledge_base_ids']) {
      console.log(`    ${k.padEnd(26)} ${JSON.stringify(llmRow[k])?.slice(0, 260)}`);
    }

    console.log('\n--- publish-agent-version ---');
    await service.publish(sync.agentId, sync.draftVersion, 'd5 verify');
    const published = await gw.getAgent(sync.agentId, sync.draftVersion);
    await fixture('d5-get-agent-after-publish', published);
    console.log(`published: version=${published.version} is_published=${published.is_published}`);

    console.log('\n--- edit after publish (must branch a new draft, ADR 0003 §7) ---');
    const secondStarted = Date.now();
    const second = await service.syncDraft({ ...input, retellAgentId: agentId, retellLlmId: llmId });
    console.log(`branched draft v${second.draftVersion} (was v${sync.draftVersion}) in ${Date.now() - secondStarted} ms`);
    await fixture('d5-create-agent-version', await gw.getAgent(sync.agentId));

    console.log('\n--- negative control: does Retell really reject choices: [] ? ---');
    await emptyChoicesProbe(gw, stack);
  } finally {
    if (!keep && agentId) {
      await gw.deleteAgent(agentId).catch((e: unknown) => console.log('agent cleanup:', String(e)));
      if (llmId) await gw.deleteLlm(llmId).catch((e: unknown) => console.log('llm cleanup:', String(e)));
      console.log('\ntorn down.');
    }
  }
}

/**
 * The claim the whole Priority 1 change rests on is the SDK's own sentence: an enum
 * analysis field's choices "must be non empty array". Asserting it against the live API
 * turns that from documentation into evidence.
 */
async function emptyChoicesProbe(gw: RetellGateway, stack: TierStack): Promise<void> {
  let llmId = '';
  let agentId = '';
  try {
    const llm = await gw.createLlm({ prompt: 'A prompt long enough to be real.', model: stack.model as never });
    llmId = llm.llm_id;
    const agent = await gw.createAgent({
      name: 'd5-verify-choices',
      llmId,
      voiceId: stack.default_voice_id,
      language: 'en-US',
      maxCallDurationMs: 600_000,
      postCallAnalysis: [
        { type: 'enum', name: 'bad_field', description: 'An enum with no choices.', choices: [] },
      ],
    });
    agentId = agent.agent_id;
    console.log('  RESULT: ACCEPTED — Retell did not reject an empty choices array (unexpected)');
  } catch (error) {
    console.log(`  RESULT: rejected — ${String(error).slice(0, 200)}`);
  } finally {
    if (agentId) await gw.deleteAgent(agentId).catch(() => {});
    if (llmId) await gw.deleteLlm(llmId).catch(() => {});
  }
}

async function tierStackFromDb(tier: 'standard' | 'premium'): Promise<TierStack> {
  const row = await adminDb.agentStackConfig.findFirst({ orderBy: { version: 'desc' } });
  if (!row) throw new Error('no agent_stack_configs row — run `pnpm db:seed`');
  return agentStackTiers.parse(row.tiersJson)[tier];
}

function report(agent: Record<string, unknown>): void {
  const keys = [
    'language', 'voice_id', 'voice_model', 'voice_speed', 'voice_temperature',
    'max_call_duration_ms', 'denoising_mode', 'stt_mode', 'post_call_analysis_model',
    'post_call_analysis_data', 'timezone', 'webhook_url', 'version', 'is_published',
  ];
  console.log('  what Retell stored:');
  for (const k of keys) console.log(`    ${k.padEnd(24)} ${JSON.stringify(agent[k])?.slice(0, 220)}`);
}

async function fixture(name: string, data: unknown): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  await writeFile(file, `${JSON.stringify({ captured_at: new Date().toISOString(), data }, null, 2)}\n`);
  console.log(`  fixture → ${path.relative(process.cwd(), file)}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('\nFAILED:', error);
    process.exit(1);
  });
