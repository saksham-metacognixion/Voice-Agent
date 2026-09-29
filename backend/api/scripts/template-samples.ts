/* eslint-disable no-console */
/**
 * Records the W1 "Hear a sample" clips (`templates/*.json` → `sample_audio_url`) on our own
 * voice stack, so a clip sounds like the product and never like the vendor's catalogue.
 *
 *   pnpm --filter @portal/api samples:templates             # every template
 *   pnpm --filter @portal/api samples:templates restaurant  # just the named ones
 *
 * Per template: a throwaway `dev-sample-<id>` LLM + agent whose begin message is the
 * script below, on the template's tier (model and voice model from `agent_stack_configs`),
 * a browser web call from headless Chrome with a *silent* fake microphone (Chrome's default
 * fake device beeps, which the agent would hear and answer), a hang-up once the agent has
 * said its line, then the call recording → trimmed, loudness-normalised mp3 in
 * `frontend/web/public/samples/<id>.mp3`. The agent and LLM are deleted afterwards.
 *
 * Why not a text-to-speech call: there is no TTS route (ADR 0003 §9), and the vendor's own
 * preview clips say its name (ADR 0020 §5). A call recording is audio of ours. The scripts
 * name only fictional businesses. Costs a few cents of call time per clip; no number is
 * bought. Needs `RETELL_API_KEY`, Postgres (the tier stack), Chrome and ffmpeg.
 */
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adminDb } from '@portal/db';
import { agentStackTiers } from '../src/modules/retell/retell.types';
import { RetellConfig } from '../src/modules/retell/retell.config';
import { RetellGateway } from '../src/modules/retell/retell.gateway';

const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = path.join(ROOT, 'frontend/web/public/samples');
const PNPM = path.join(ROOT, 'node_modules/.pnpm');
const PORT = 8765;

/** ~20 s each, in the persona the template's `brief_prefill.agent_name` sets. */
const SAMPLES: Record<string, { voice: string; text: string }> = {
  receptionist: {
    voice: '11labs-Chloe',
    text: "Thanks for calling Northside Dental, this is Sophie. We're open Monday to Friday, nine to five, right across from the library on Main Street. Doctor Patel is with a patient at the moment, but I can take a message and make sure she calls you back this afternoon. Can I start with your name and the best number to reach you?",
  },
  appointment: {
    voice: '11labs-Chloe',
    text: "Hi, you've reached Glow Hair Studio, this is Sophie. I'd be happy to set up an appointment for you. Is it for a cut, colour, or styling? And have you visited us before? Give me two days and times that suit you, and the team will confirm your booking by text within the hour.",
  },
  afterhours: {
    voice: '11labs-Chloe',
    text: "Thanks for calling Summit Plumbing. Our office is closed right now, and we open again tomorrow at eight. If water is leaking or you have no heat, tell me and I'll reach our on-call technician straight away. Otherwise, leave your name, your number and what you need, and someone will call you first thing in the morning.",
  },
  faq_support: {
    voice: '11labs-Adrian',
    text: "Hi, thanks for calling Brightline support, this is Sam. I can help with your account, billing, and getting set up. For example, you can reset your password from the sign-in page by choosing Forgot password. If there's something I can't answer, I'll take your details and a specialist will follow up by email today.",
  },
  lead_qual: {
    voice: '11labs-Brian',
    text: 'Hi, thanks for calling Harbour Realty, this is Alex. I can match you with the right agent. Are you looking to buy, or to sell? And roughly what area and price range do you have in mind? Once I have your timeline and the best number to reach you, one of our agents will call you back today.',
  },
  restaurant: {
    voice: '11labs-Marissa',
    text: "Good evening, and thank you for calling Bistro Lumière, this is Marie. I can book you a table or answer questions about the menu. Tonight we have a wild mushroom risotto, and yes, it's vegetarian. How many people is the reservation for, and what time works for you? For parties over eight, I'll pass you to our events team.",
  },
  custom: {
    voice: '11labs-Chloe',
    text: 'Hello, thanks for calling Riverside Community Centre, this is Sophie. I can tell you about our programs, opening hours and upcoming events, or take a message for any of our staff. The pool is open every day from six in the morning until nine at night. How can I help you today?',
  },
};

const SILENT_PROMPT = `You have already said your opening line. Do not say anything else.
If the caller speaks, stay silent. Never mention any company other than the one in your opening.`;

/** The page the headless browser loads: the SDK's own ESM builds behind an import map. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>sample</title>
<script type="importmap">{"imports":{"eventemitter3":"/ee3.mjs","livekit-client":"/livekit.mjs"}}</script>
<script type="module">
import { RetellClient } from '/retell.mjs';
window.record = async () => {
  const minted = await (await fetch('/token')).json();
  const client = new RetellClient({ key: 'local', fetch: async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.includes('/create-web-call')) throw new Error('not proxied: ' + url);
    return new Response(JSON.stringify(minted), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  // The agent-talking hooks do not fire on the v3 gateway transport (status frames only),
  // so the call is held for the line's estimated length and the recording is cut later.
  return await new Promise((resolve) => {
    let live = false;
    const hangUp = () => s.end().catch(() => s.disconnect());
    const s = client.createWebCall({ agent_id: minted.agent_id, transcript: false, hooks: {
      onStatus: (st) => {
        if (st === 'live' && !live) { live = true; setTimeout(hangUp, minted.hold_ms); }
        if (st === 'ended') resolve({ ok: live, error: live ? undefined : 'never went live' });
      },
      onError: (e) => resolve({ ok: false, error: String(e && e.message || e) }),
    } });
    setTimeout(hangUp, 90000);
  });
};
</script>`;

/**
 * The opening line only: from the first sound to the first pause of over a second. What
 * follows it — the platform's "are you still there?" nudge, the hang-up — is not the line.
 */
function speechSpan(file: string): { from: number; to: number } {
  // ffmpeg writes the filter's report to stderr.
  const report = execFileSync(
    'sh',
    ['-c', `ffmpeg -hide_banner -i "$0" -af silencedetect=n=-45dB:d=1.2 -f null - 2>&1`, file],
    { encoding: 'utf8' },
  );
  const starts = [...report.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...report.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const from = starts[0] !== undefined && starts[0] < 0.05 ? (ends[0] ?? 0) : 0;
  const to = starts.find((t) => t > from + 3);
  if (to === undefined) throw new Error('no pause after the line — the recording ends mid-speech');
  return { from: Math.max(0, from - 0.1), to: to + 0.25 };
}

function pkgFile(dirPrefix: string, pkg: string, file: string): string {
  const dir = require('node:fs')
    .readdirSync(PNPM)
    .find((d: string) => d.startsWith(dirPrefix));
  if (!dir)
    throw new Error(`${pkg} not installed (looked for ${dirPrefix}* in node_modules/.pnpm)`);
  return path.join(PNPM, dir, 'node_modules', pkg, file);
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const ids = only.length ? only : Object.keys(SAMPLES);
  for (const id of ids) if (!SAMPLES[id]) throw new Error(`no sample script for template "${id}"`);

  const gw = new RetellGateway(new RetellConfig());
  gw.config.assertConfigured();
  const row = await adminDb.agentStackConfig.findFirst({ orderBy: { version: 'desc' } });
  if (!row) throw new Error('agent_stack_configs is empty — run pnpm db:seed');
  const tiers = agentStackTiers.parse(row.tiersJson);

  const files: Record<string, [string, string]> = {
    '/retell.mjs': [
      pkgFile('retell-client-js-sdk@', 'retell-client-js-sdk', 'dist/index.modern.mjs'),
      'text/javascript',
    ],
    '/livekit.mjs': [
      pkgFile('livekit-client@', 'livekit-client', 'dist/livekit-client.esm.mjs'),
      'text/javascript',
    ],
    '/ee3.mjs': [
      pkgFile('eventemitter3@5', 'eventemitter3', 'dist/eventemitter3.esm.js'),
      'text/javascript',
    ],
  };
  let minted: unknown = null;
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (url === '/token')
      return void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(minted));
    const file = files[url];
    if (file)
      return void res.writeHead(200, { 'content-type': file[1] }).end(readFileSync(file[0]));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));

  const work = mkdtempSync(path.join(tmpdir(), 'samples-'));
  const silence = path.join(work, 'silence.wav');
  execFileSync('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=mono',
    '-t',
    '120',
    silence,
  ]);
  const { launch } = await import(path.join(ROOT, 'frontend/web/scripts/cdp.mjs'));
  const browser = await launch({
    port: 9334,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${silence}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  mkdirSync(OUT_DIR, { recursive: true });

  const failed: string[] = [];
  try {
    for (const id of ids) {
      const template = JSON.parse(
        readFileSync(path.join(ROOT, 'templates', `${id}.json`), 'utf8'),
      ) as { default_tier: 'standard' | 'premium' };
      const stack = tiers[template.default_tier];
      const sample = SAMPLES[id];
      let llmId: string | null = null;
      let agentId: string | null = null;
      try {
        console.log(`\n[${id}] ${template.default_tier}, ${sample.voice}`);
        const llm = await gw.createLlm({
          prompt: SILENT_PROMPT,
          beginMessage: sample.text,
          model: stack.model,
        });
        llmId = llm.llm_id;
        const agent = await gw.createAgent({
          name: `sample-${id}`,
          llmId,
          voiceId: sample.voice,
          voiceModel: stack.voice_model,
          language: 'en-US',
          maxCallDurationMs: 90_000,
          denoisingMode: stack.denoising_mode,
          sttMode: stack.stt_mode,
        });
        agentId = agent.agent_id;
        const call = await gw.createWebCall({
          agentId,
          agentVersion: 0,
          metadata: { purpose: 'template_sample', template_id: id },
        });
        const callId = call.call_id;
        // ~2.5 words a second, plus the pickup; the tail is cut from the recording below.
        minted = { ...call, hold_ms: (sample.text.split(/\s+/).length / 2.5) * 1000 + 8000 };

        await browser.goto(`http://127.0.0.1:${PORT}/`, 1500);
        const result = (await browser.evaluate('window.record()')) as {
          ok: boolean;
          error?: string;
        };
        if (!result.ok)
          throw new Error(`call did not play the line: ${result.error ?? 'agent never spoke'}`);

        let recording: string | null = null;
        for (let i = 0; i < 40 && !recording; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const call = (await gw.getCall(callId)) as { recording_url?: string | null };
          recording = call.recording_url ?? null;
        }
        if (!recording) throw new Error(`no recording for ${callId} after 2 min`);
        const raw = path.join(work, `${id}.raw`);
        writeFileSync(raw, Buffer.from(await (await fetch(recording)).arrayBuffer()));

        const out = path.join(OUT_DIR, `${id}.mp3`);
        const { from, to } = speechSpan(raw);
        execFileSync('ffmpeg', [
          '-loglevel',
          'error',
          '-y',
          '-i',
          raw,
          '-af',
          `atrim=start=${from}:end=${to},asetpts=PTS-STARTPTS,loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:d=0.05`,
          '-ac',
          '1',
          '-ar',
          '44100',
          '-b:a',
          '96k',
          out,
        ]);
        const seconds = execFileSync('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'csv=p=0',
          out,
        ])
          .toString()
          .trim();
        console.log(
          `[${id}] call ${callId} → ${path.relative(ROOT, out)} (${Number(seconds).toFixed(1)} s)`,
        );
      } catch (error) {
        failed.push(id);
        console.error(`[${id}] FAILED:`, error instanceof Error ? error.message : error);
      } finally {
        if (agentId)
          await gw
            .deleteAgent(agentId)
            .catch((e) => console.error(`[${id}] agent cleanup:`, e.message));
        if (llmId)
          await gw.deleteLlm(llmId).catch((e) => console.error(`[${id}] llm cleanup:`, e.message));
      }
    }
  } finally {
    browser.close();
    server.close();
    await adminDb.$disconnect();
  }
  if (browser.logs.length) console.log('\nbrowser:', browser.logs.slice(-10).join('\n'));
  if (failed.length) {
    console.error(`\nfailed: ${failed.join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
