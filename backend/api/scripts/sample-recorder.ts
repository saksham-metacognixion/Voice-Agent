/**
 * The harness behind `samples:templates` and `samples:voices`: a throwaway LLM + agent
 * whose begin message is the line, a browser web call from headless Chrome with a
 * *silent* fake microphone (Chrome's default fake device beeps, which the agent would hear
 * and answer), a hang-up once the line has been said, then the call recording → trimmed,
 * loudness-normalised mp3. The agent and LLM are deleted afterwards.
 *
 * Why a call and not text-to-speech: there is no TTS route (ADR 0003 §9), and the
 * vendor's own preview clips say its name (ADR 0020 §5). A call recording is audio of ours.
 * Needs `RETELL_API_KEY`, Chrome and ffmpeg. No number is bought.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentSpec, Language, LlmSpec, TierStack, VoiceModel } from '../src/modules/retell/retell.types';
import type { RetellGateway } from '../src/modules/retell/retell.gateway';

export const ROOT = path.resolve(__dirname, '../../..');
const PNPM = path.join(ROOT, 'node_modules/.pnpm');

export const SILENT_PROMPT = `You have already said your opening line. Do not say anything else.
If the caller speaks, stay silent. Never mention any company other than the one in your opening.`;

/** The page each headless browser loads: the SDK's own ESM builds behind an import map. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>sample</title>
<script type="importmap">{"imports":{"eventemitter3":"/ee3.mjs","livekit-client":"/livekit.mjs"}}</script>
<script type="module">
import { RetellClient } from '/retell.mjs';
window.record = async (minted) => {
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

interface Browser {
  goto(url: string, wait?: number): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  close(): void;
  logs: string[];
}

export interface Recorder {
  browsers: Browser[];
  record(
    browser: Browser,
    line: SampleLine,
    out: string,
  ): Promise<{ callId: string; seconds: number }>;
  close(): void;
}

export interface SampleLine {
  /** Names the throwaway agent; `dev-` keeps it recognisable as ours on the platform. */
  name: string;
  text: string;
  voiceId: string;
  voiceModel: VoiceModel | null;
  language: Language;
  stack: TierStack;
  metadata: Record<string, string>;
  /** mp3 bitrate; 96k for W1's longer template clips, less for a short voice line. */
  bitrate?: string;
}

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
  const to = starts.find((t) => t > from + 2);
  if (to === undefined) throw new Error('no pause after the line — the recording ends mid-speech');
  return { from: Math.max(0, from - 0.1), to: to + 0.25 };
}

function pkgFile(dirPrefix: string, pkg: string, file: string): string {
  const dir = readdirSync(PNPM).find((d: string) => d.startsWith(dirPrefix));
  if (!dir)
    throw new Error(`${pkg} not installed (looked for ${dirPrefix}* in node_modules/.pnpm)`);
  return path.join(PNPM, dir, 'node_modules', pkg, file);
}

/** How long to hold the call: the line at a speaking pace, plus the pickup. */
function holdMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  // A CJK line has no spaces; count characters at ~5 a second instead.
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length;
  return Math.max(words / 2.5, cjk / 5) * 1000 + 8000;
}

export async function startRecorder(
  gw: RetellGateway,
  options: { browsers?: number; port?: number } = {},
): Promise<Recorder> {
  const port = options.port ?? 8765;
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
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    const file = files[url];
    if (file)
      return void res.writeHead(200, { 'content-type': file[1] }).end(readFileSync(file[0]));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));

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
  const browsers: Browser[] = [];
  for (let i = 0; i < (options.browsers ?? 1); i++) {
    browsers.push(
      await launch({
        port: 9334 + i,
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          `--use-file-for-fake-audio-capture=${silence}`,
          '--autoplay-policy=no-user-gesture-required',
        ],
      }),
    );
  }

  async function record(browser: Browser, line: SampleLine, out: string) {
    let llmId: string | null = null;
    let agentId: string | null = null;
    try {
      const llm = await gw.createLlm({
        prompt: SILENT_PROMPT,
        beginMessage: line.text,
        model: line.stack.model as LlmSpec['model'],
      });
      llmId = llm.llm_id;
      const agent = await gw.createAgent({
        name: line.name,
        llmId,
        voiceId: line.voiceId,
        voiceModel: line.voiceModel,
        language: line.language,
        maxCallDurationMs: 90_000,
        denoisingMode: line.stack.denoising_mode,
        sttMode: line.stack.stt_mode,
      } satisfies AgentSpec);
      agentId = agent.agent_id;
      const call = await gw.createWebCall({ agentId, agentVersion: 0, metadata: line.metadata });
      const callId = call.call_id;
      const minted = { ...call, hold_ms: holdMs(line.text) };

      await browser.goto(`http://127.0.0.1:${port}/`, 1500);
      const result = (await browser.evaluate(`window.record(${JSON.stringify(minted)})`)) as
        { ok: boolean; error?: string } | undefined;
      if (!result?.ok)
        throw new Error(`call did not play the line: ${result?.error ?? 'agent never spoke'}`);

      let recording: string | null = null;
      for (let i = 0; i < 40 && !recording; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const got = (await gw.getCall(callId)) as { recording_url?: string | null };
        recording = got.recording_url ?? null;
      }
      if (!recording) throw new Error(`no recording for ${callId} after 2 min`);
      const raw = path.join(work, `${path.basename(out)}.raw`);
      writeFileSync(raw, Buffer.from(await (await fetch(recording)).arrayBuffer()));

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
        line.bitrate ?? '96k',
        // No encoder tag or title: nothing in the file names a tool or a vendor.
        '-map_metadata',
        '-1',
        '-fflags',
        '+bitexact',
        out,
      ]);
      const seconds = Number(
        execFileSync('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'csv=p=0',
          out,
        ])
          .toString()
          .trim(),
      );
      return { callId, seconds };
    } finally {
      if (agentId)
        await gw
          .deleteAgent(agentId)
          .catch((e: Error) => console.error(`[${line.name}] agent cleanup:`, e.message));
      if (llmId)
        await gw
          .deleteLlm(llmId)
          .catch((e: Error) => console.error(`[${line.name}] llm cleanup:`, e.message));
    }
  }

  return {
    browsers,
    record,
    close() {
      for (const b of browsers) b.close();
      server.close();
    },
  };
}
