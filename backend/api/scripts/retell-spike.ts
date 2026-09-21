/* eslint-disable no-console */
/**
 * D2 Retell spike — drives RetellGateway against the real account and writes every API
 * response to test/fixtures/retell/api/ so ADR 0003 cites bytes, not memory.
 *
 *   pnpm --filter @portal/api spike:retell <command> [flags]
 *
 *   voices                         list-voices → fixture + provider summary
 *   concurrency                    account concurrency ceiling
 *   setup [--voice id] [--model m] create LLM + agent (draft v0), publish v0, edit → draft v1,
 *                                  list versions. Saves ids to .retell-spike.json
 *   publish --version N            publish a draft version (--version is required)
 *   agent [--version N]            get-agent (latest, or a specific version)
 *   new-version [--base N]         open a draft from a published version (create-agent-version)
 *   edit [--max-ms N]              update the latest draft (422 if the latest version is published)
 *   versions                       list agent versions
 *   web-call [--version N] [--max-ms N]   mint a browser call token
 *   number buy [--area 415] [--country US|CA] [--toll-free]
 *   number mode <allow|decline_reject|decline_403|decline_404|decline_500|decline_timeout> [--response '<json>']
 *   setup-caller                   second agent + number that phones the spike number and never hangs up
 *   number bind [--version latest_published|N]   pin (or unpin) the inbound agent version
 *   number list | number delete [--all]   --all also sweeps `<env>-spike…` numbers missing from the state file
 *   phone-call [--to +1...] [--from +1...] [--agent caller|receptionist] [--max-ms N]   caller → spike number
 *   wait [call_id] [--timeout s]   poll get-call until ended → fixture + metering summary
 *   call <call_id>                 get-call → fixture (call_cost, analysis, duration)
 *   calls [--hours 24]             list-calls window
 *   kb                             create KB (text + url), poll, add source, fixture
 *   teardown [--caller-only]       delete numbers, agents, LLMs, KB from the state file
 *
 * Every Retell object is `dev-` prefixed by RetellConfig. Nothing here touches Postgres.
 */
import 'reflect-metadata';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RetellConfig } from '../src/modules/retell/retell.config';
import { RetellGateway } from '../src/modules/retell/retell.gateway';
import type { Language, LlmModel, VoiceModel } from '../src/modules/retell/retell.types';

const STATE_FILE = path.resolve(__dirname, '../.retell-spike.json');
const FIXTURE_DIR = path.resolve(__dirname, '../test/fixtures/retell/api');

interface State {
  llm_id?: string;
  agent_id?: string;
  caller_llm_id?: string;
  caller_agent_id?: string;
  caller_number?: string;
  kb_id?: string;
  numbers?: string[];
  number_token?: string;
  calls?: string[];
}

const SPIKE_PROMPT = `You are the receptionist for Maple Dental, a family dental clinic in Toronto.
Business hours are Monday to Friday 9am to 5pm. Greet the caller warmly, find out whether they
want to book an appointment, ask a question, or something else, collect their name, and answer
in one or two short sentences. If the caller asks anything you cannot answer, say the office will
call them back. Keep every reply under 25 words. When the caller says goodbye, end the call.`;

async function main() {
  const [command, sub, ...rest] = process.argv.slice(2);
  const flags = parseFlags([sub, ...rest]);
  const gw = new RetellGateway(new RetellConfig());
  gw.config.assertConfigured(); // every command here talks to Retell; say so before doing work
  const state = await loadState();

  switch (command) {
    case 'voices': {
      const voices = await gw.listVoices();
      await fixture('list-voices', voices);
      const byProvider = new Map<string, number>();
      for (const v of voices) byProvider.set(v.provider, (byProvider.get(v.provider) ?? 0) + 1);
      console.log(`${voices.length} voices`, Object.fromEntries(byProvider));
      console.log('fields on a voice:', Object.keys(voices[0] ?? {}).join(', '));
      console.log('has preview_audio_url:', voices.filter((v) => v.preview_audio_url).length);
      return;
    }
    case 'concurrency': {
      const c = await gw.getConcurrency();
      await fixture('get-concurrency', c);
      console.log(c);
      return;
    }
    case 'setup': {
      const model = (flags.model as LlmModel) ?? 'gpt-5-mini';
      const voiceId = (flags.voice as string) ?? '11labs-Adrian';
      const voiceModel = (flags['voice-model'] as VoiceModel) ?? 'eleven_flash_v2_5';
      const language = ((flags.language as string) ?? 'en-US,fr-CA').split(',') as Language;

      const llm = await gw.createLlm({
        prompt: SPIKE_PROMPT,
        beginMessage: 'Thank you for calling {{business_name}}, this is {{agent_name}}. How can I help you today?',
        model,
        defaultDynamicVariables: { business_name: 'Maple Dental', agent_name: 'Maya' },
      });
      await fixture('create-retell-llm', llm);
      state.llm_id = llm.llm_id;

      const agent = await gw.createAgent({
        name: 'spike-receptionist',
        llmId: llm.llm_id,
        voiceId,
        voiceModel,
        language,
        maxCallDurationMs: 600_000,
        timezone: 'America/Toronto',
        // §9.8 assumes text/number/boolean/enum; this is the check.
        postCallAnalysis: [
          { type: 'string', name: 'caller_name', description: 'The caller’s name if given.', examples: ['Jane Doe'] },
          { type: 'enum', name: 'call_reason', description: 'Why they called.', choices: ['appointment', 'question', 'other'] },
          { type: 'boolean', name: 'callback_requested', description: 'True if the caller asked to be called back.' },
          { type: 'number', name: 'party_size', description: 'Number of people the appointment is for, if stated.' },
        ],
      });
      await fixture('create-agent', agent);
      state.agent_id = agent.agent_id;
      console.log(`agent ${agent.agent_id} version=${agent.version} is_published=${agent.is_published}`);

      await gw.publishAgent(agent.agent_id, agent.version, 'spike v0');
      const published = await gw.getAgent(agent.agent_id);
      await fixture('get-agent-after-publish', published);
      console.log(`after publish: version=${published.version} is_published=${published.is_published}`);

      // Edit after publish: does Retell open a new draft, and does the published one stay put?
      const edited = await gw.updateAgent(agent.agent_id, {
        name: 'spike-receptionist',
        llmId: llm.llm_id,
        voiceId,
        voiceModel,
        language,
        maxCallDurationMs: 540_000,
        timezone: 'America/Toronto',
      });
      await fixture('update-agent-after-publish', edited);
      console.log(`after edit: version=${edited.version} is_published=${edited.is_published}`);

      const versions = await gw.listAgentVersions(agent.agent_id);
      await fixture('list-agent-versions', versions);
      console.log('versions:', summariseVersions(versions));
      await saveState(state);
      return;
    }
    case 'publish': {
      const version = requiredIntFlag(flags, 'version');
      await gw.publishAgent(need(state.agent_id, 'agent_id'), version, `spike v${version}`);
      const agent = await gw.getAgent(state.agent_id!);
      await fixture(`get-agent-after-publish-v${version}`, agent);
      console.log(`published v${version}; latest version=${agent.version} is_published=${agent.is_published}`);
      return;
    }
    case 'agent': {
      const agent = await gw.getAgent(need(state.agent_id, 'agent_id'), intFlag(flags, 'version'));
      await fixture(flags.version === undefined ? 'get-agent' : `get-agent-v${flags.version}`, agent);
      console.log(`version=${agent.version} is_published=${agent.is_published} max=${agent.max_call_duration_ms} tags=${JSON.stringify((agent as Record<string, unknown>).assigned_tags)}`);
      return;
    }
    case 'new-version': {
      const current = await gw.getAgent(need(state.agent_id, 'agent_id'));
      const draft = await gw.createAgentVersion(state.agent_id!, intFlag(flags, 'base') ?? current.version);
      await fixture('create-agent-version', draft);
      console.log(`draft opened: ${JSON.stringify(draft)}`);
      return;
    }
    case 'edit': {
      // Edit after publish: does Retell open a new draft, and does the published one stay put?
      const current = await gw.getAgent(need(state.agent_id, 'agent_id'));
      const engine = current.response_engine as { llm_id?: string };
      const edited = await gw.updateAgent(state.agent_id!, {
        name: 'spike-receptionist',
        llmId: engine.llm_id ?? need(state.llm_id, 'llm_id'),
        voiceId: current.voice_id,
        voiceModel: current.voice_model ?? undefined,
        language: current.language ?? 'en-US',
        maxCallDurationMs: intFlag(flags, 'max-ms') ?? 540_000,
        timezone: 'America/Toronto',
      });
      await fixture('update-agent-after-publish', edited);
      console.log(`before: version=${current.version} is_published=${current.is_published}; after edit: version=${edited.version} is_published=${edited.is_published} max=${edited.max_call_duration_ms}`);
      return;
    }
    case 'versions': {
      const versions = await gw.listAgentVersions(need(state.agent_id, 'agent_id'));
      await fixture('list-agent-versions', versions);
      console.log(summariseVersions(versions));
      return;
    }
    case 'web-call': {
      const call = await gw.createWebCall({
        agentId: need(state.agent_id, 'agent_id'),
        agentVersion: intFlag(flags, 'version') ?? 0,
        metadata: { test: true, source: 'spike' },
        maxCallDurationMs: intFlag(flags, 'max-ms'),
      });
      await fixture('create-web-call', { ...call, access_token: '[redacted]' });
      state.calls = [...(state.calls ?? []), call.call_id];
      await saveState(state);
      console.log(JSON.stringify({ call_id: call.call_id, access_token: call.access_token }, null, 2));
      return;
    }
    case 'number': {
      if (sub === 'buy') {
        const token = state.number_token ?? `spike_${Math.random().toString(36).slice(2, 14)}`;
        const number = await gw.createPhoneNumber({
          numberToken: token,
          agentId: need(state.agent_id, 'agent_id'),
          country: (flags.country as 'US' | 'CA') ?? 'US',
          areaCode: intFlag(flags, 'area'),
          tollFree: Boolean(flags['toll-free']),
          nickname: 'spike-inbound',
        });
        await fixture('create-phone-number', number);
        state.number_token = token;
        state.numbers = [...(state.numbers ?? []), number.phone_number];
        await saveState(state);
        console.log(number);
        return;
      }
      if (sub === 'mode') {
        const mode = rest[0];
        const e164 = (flags.number as string) ?? need(state.numbers?.[0], 'numbers[0]');
        const response = flags.response ? `&response=${Buffer.from(String(flags.response)).toString('base64url')}` : '';
        const url = `${gw.config.inboundWebhookUrl(need(state.number_token, 'number_token'))}?mode=${mode}${response}`;
        const updated = await gw.client.phoneNumber.update(e164, { inbound_webhook_url: url });
        await fixture(`update-phone-number-mode-${mode}`, updated);
        console.log(`inbound_webhook_url → ${updated.inbound_webhook_url}`);
        return;
      }
      if (sub === 'bind') {
        // Pin the binding to a tag. Without agent_version the number runs `latest`, drafts
        // included (test 1 on D2 ran the unpublished v1) — which is why RetellGateway.binding()
        // now always sends `latest_published` (§9.9, ADR 0003 §7). Kept for re-testing the tag.
        const e164 = (flags.number as string) ?? need(state.numbers?.[0], 'numbers[0]');
        const raw = flags.version as string | undefined;
        const agent_version = raw === undefined ? undefined : /^\d+$/.test(raw) ? Number(raw) : raw;
        const updated = await gw.client.phoneNumber.update(e164, {
          inbound_agents: [{ agent_id: need(state.agent_id, 'agent_id'), weight: 1, ...(agent_version === undefined ? {} : { agent_version }) }],
        });
        await fixture(`update-phone-number-bind-${raw ?? 'unpinned'}`, updated);
        console.log('inbound_agents →', JSON.stringify(updated.inbound_agents));
        return;
      }
      if (sub === 'list') {
        const numbers = await gw.listPhoneNumbers();
        await fixture('list-phone-numbers', numbers);
        console.log(numbers.map((n) => `${n.phone_number} ${n.phone_number_type} ${n.nickname ?? ''} → ${n.inbound_webhook_url ?? '-'}`).join('\n'));
        return;
      }
      if (sub === 'delete') {
        // Default: only what this machine's state file created. `--all` sweeps numbers the
        // state file lost track of, but it is still scoped by nickname prefix (`dev-spike…`,
        // from RetellConfig.objectName) — one Retell workspace per environment is shared, so
        // deleting every number in the account would take other people's numbers with it.
        const tracked = [...(state.numbers ?? []), ...(state.caller_number ? [state.caller_number] : [])];
        let targets = tracked;
        if (flags.all) {
          const prefix = gw.config.objectName('spike');
          const all = await gw.listPhoneNumbers();
          const mine = all.filter((n) => n.nickname?.startsWith(prefix));
          const skipped = all.length - mine.length;
          targets = [...new Set([...tracked, ...mine.map((n) => n.phone_number)])];
          if (skipped) console.log(`--all: leaving ${skipped} number(s) alone; only "${prefix}…" nicknames are the spike's`);
        }
        if (!targets.length) {
          console.log('nothing to delete');
          return;
        }
        for (const e164 of targets) {
          await gw.deletePhoneNumber(e164).then(() => console.log(`deleted ${e164}`), warn);
        }
        state.numbers = [];
        delete state.caller_number;
        await saveState(state);
        return;
      }
      throw new Error('number buy|mode|list|delete');
    }
    case 'setup-caller': {
      // A second agent + number that *calls* the spike number, so inbound behaviour can be
      // exercised without a human dialling. Never says goodbye: max_call_duration_ms is the
      // only thing that ends the call, which is what the §21 override test needs.
      const llm = await gw.createLlm({
        prompt: `You are Sam, a prospective patient phoning Maple Dental for the first time. You are
chatty and curious. Ask one question at a time about opening hours, parking, whether they take
new patients, cleaning prices, and emergency appointments. After each answer, thank them briefly
and ask the next question. Never say goodbye, never end the call, never say you are done. If
there is silence, ask another question. Speak English only.`,
        beginMessage: 'Hi there, is this Maple Dental? I had a few questions.',
        model: (flags.model as LlmModel) ?? 'gpt-5-mini',
      });
      await fixture('create-retell-llm-caller', llm);
      const agent = await gw.createAgent({
        name: 'spike-caller',
        llmId: llm.llm_id,
        voiceId: (flags.voice as string) ?? '11labs-Adrian',
        language: 'en-US',
        maxCallDurationMs: 600_000,
      });
      await fixture('create-agent-caller', agent);
      await gw.publishAgent(agent.agent_id, agent.version, 'caller v0');
      state.caller_llm_id = llm.llm_id;
      state.caller_agent_id = agent.agent_id;
      const number = await gw.createPhoneNumber({
        numberToken: `caller_${Math.random().toString(36).slice(2, 14)}`,
        agentId: agent.agent_id,
        country: 'US',
        nickname: 'spike-caller',
      });
      await fixture('create-phone-number-caller', number);
      state.caller_number = number.phone_number;
      await saveState(state);
      console.log(`caller agent ${agent.agent_id} on ${number.phone_number}`);
      return;
    }
    case 'phone-call': {
      const call = await gw.createPhoneCall({
        fromNumber: (flags.from as string) ?? need(state.caller_number ?? state.numbers?.[0], 'from number'),
        toNumber: (flags.to as string) ?? need(state.numbers?.[0], 'numbers[0]'),
        agentId: flags.agent === 'receptionist' ? need(state.agent_id, 'agent_id') : need(state.caller_agent_id ?? state.agent_id, 'caller_agent_id'),
        agentVersion: intFlag(flags, 'version'),
        metadata: { test: true, source: 'spike-outbound' },
        maxCallDurationMs: intFlag(flags, 'max-ms'),
      });
      await fixture('create-phone-call', call);
      state.calls = [...(state.calls ?? []), call.call_id];
      await saveState(state);
      console.log(`call ${call.call_id} status=${call.call_status}`);
      return;
    }
    case 'wait': {
      // Poll until the call leaves registered/ongoing, then print what metering needs.
      const id = need(sub && !sub.startsWith('--') ? sub : state.calls?.at(-1), 'call_id');
      const started = Date.now();
      let call = await gw.getCall(id);
      while ((call.call_status === 'registered' || call.call_status === 'ongoing') && Date.now() - started < (intFlag(flags, 'timeout') ?? 240) * 1000) {
        await sleep(5_000);
        call = await gw.getCall(id);
        process.stdout.write(`\r  ${call.call_status} ${Math.round((Date.now() - started) / 1000)}s   `);
      }
      console.log();
      await fixture(`get-call-${call.call_id}`, call);
      const dur = call.start_timestamp && call.end_timestamp ? (call.end_timestamp - call.start_timestamp) / 1000 : undefined;
      console.log(JSON.stringify({ call_id: call.call_id, status: call.call_status, reason: call.disconnection_reason, duration_s: dur, duration_ms: call.duration_ms, cost_cents: call.call_cost?.combined_cost, products: call.call_cost?.product_costs?.map((p) => `${p.product}:${p.cost}`), analysis: call.call_analysis?.custom_analysis_data }, null, 2));
      return;
    }
    case 'call': {
      const call = await gw.getCall(need(sub, 'call_id'));
      await fixture(`get-call-${call.call_id}`, call);
      const c = call as Record<string, unknown>;
      console.log(
        JSON.stringify(
          {
            call_id: call.call_id,
            call_type: call.call_type,
            call_status: call.call_status,
            disconnection_reason: call.disconnection_reason,
            start_timestamp: call.start_timestamp,
            end_timestamp: call.end_timestamp,
            duration_ms: call.duration_ms,
            call_cost: call.call_cost,
            call_analysis: call.call_analysis,
            agent_version: c.agent_version,
            metadata: call.metadata,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'calls': {
      const hours = intFlag(flags, 'hours') ?? 24;
      const calls = await gw.listCalls(Date.now() - hours * 3_600_000);
      await fixture('list-calls', calls);
      for (const c of calls) {
        console.log(`${c.call_id} ${c.call_type} ${c.call_status} ${c.disconnection_reason ?? ''} ${c.duration_ms ?? ''}ms cost=${c.call_cost?.combined_cost ?? '-'}c`);
      }
      return;
    }
    case 'kb': {
      const kb = await gw.createKnowledgeBase({
        name: 'spike-kb',
        texts: [{ title: 'Hours', text: 'Maple Dental is open Monday to Friday, 9am to 5pm. Closed on statutory holidays.' }],
        urls: ['https://www.example.com/'],
        autoRefresh: true,
      });
      await fixture('create-knowledge-base', kb);
      state.kb_id = kb.knowledge_base_id;
      await saveState(state);
      console.log(`kb ${kb.knowledge_base_id} status=${kb.status}`);

      const started = Date.now();
      let current = kb;
      while (current.status === 'in_progress' && Date.now() - started < 180_000) {
        await sleep(5_000);
        current = await gw.getKnowledgeBase(kb.knowledge_base_id);
        console.log(`  … ${current.status} after ${Math.round((Date.now() - started) / 1000)}s`);
      }
      await fixture('get-knowledge-base-after-ingest', current);
      console.log(`ingest ${current.status} in ${Math.round((Date.now() - started) / 1000)}s; sources:`, current.knowledge_base_sources?.map((s) => `${s.type}:${s.status ?? '?'}`));

      const added = await gw.addKnowledgeSources(kb.knowledge_base_id, {
        texts: [{ title: 'Parking', text: 'Free parking is available behind the building.' }],
      });
      await fixture('add-knowledge-base-sources', added);
      console.log(`after add: status=${added.status} sources=${added.knowledge_base_sources?.length}`);
      return;
    }
    case 'teardown': {
      // --caller-only removes the second number + agent (the $2/month one) and keeps the
      // receptionist + inbound number for manual phone tests.
      if (state.caller_number) await gw.deletePhoneNumber(state.caller_number).then(() => console.log(`deleted caller number ${state.caller_number}`), warn);
      if (state.caller_agent_id) await gw.deleteAgent(state.caller_agent_id).then(() => console.log(`deleted caller agent`), warn);
      if (state.caller_llm_id) await gw.deleteLlm(state.caller_llm_id).then(() => console.log(`deleted caller llm`), warn);
      delete state.caller_number; delete state.caller_agent_id; delete state.caller_llm_id;
      if (flags['caller-only']) { await saveState(state); return; }
      for (const e164 of state.numbers ?? []) await gw.deletePhoneNumber(e164).then(() => console.log(`deleted number ${e164}`), warn);
      if (state.kb_id) await gw.deleteKnowledgeBase(state.kb_id).then(() => console.log(`deleted kb ${state.kb_id}`), warn);
      if (state.agent_id) await gw.deleteAgent(state.agent_id).then(() => console.log(`deleted agent ${state.agent_id}`), warn);
      if (state.llm_id) await gw.deleteLlm(state.llm_id).then(() => console.log(`deleted llm ${state.llm_id}`), warn);
      await saveState({});
      return;
    }
    default:
      console.error('unknown command; see the header comment');
      process.exit(2);
  }
}

function summariseVersions(versions: unknown): unknown {
  const list = Array.isArray(versions) ? versions : ((versions as { items?: unknown[] }).items ?? []);
  return list.map((v) => {
    const r = v as Record<string, unknown>;
    return { version: r.version, is_published: r.is_published, tags: r.tags, base_version: r.base_version, title: r.version_title };
  });
}

/** Keys that are credentials, not shape: never into a committed fixture. */
const REDACT_KEYS = new Set(['access_token', 'sip_outbound_trunk_config', 'sip_trunk_auth_password', 'auth_password', 'auth_username']);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, REDACT_KEYS.has(k) ? '[redacted]' : redact(v)]),
    );
  }
  return value;
}

async function fixture(name: string, data: unknown): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  await writeFile(file, JSON.stringify({ captured_at: new Date().toISOString(), data: redact(data) }, null, 2) + '\n');
  console.log(`→ ${path.relative(process.cwd(), file)}`);
}

async function loadState(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as State;
  } catch {
    return {};
  }
}
async function saveState(state: State): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function parseFlags(args: (string | undefined)[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a?.startsWith('--')) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null || value === '') throw new Error(`missing ${what} (run setup / number buy first)`);
  return value;
}

/**
 * `Number(flags.x)` is NaN for a missing flag and for `--x` with no value (which parses
 * as `true`), and NaN serialises to `null` — `publish` without `--version` used to send
 * `{version: null}` to Retell and get a confusing 4xx back. Fail here instead.
 */
function intFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) throw new Error(`--${name} needs an integer, got ${raw === true ? '(no value)' : `"${String(raw)}"`}`);
  return Number(raw);
}

function requiredIntFlag(flags: Record<string, string | boolean>, name: string): number {
  const value = intFlag(flags, name);
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const warn = (e: unknown) => console.warn(String(e));

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
