/* eslint-disable no-console */
/**
 * Arabic STT proof (ADR 0027, 26 Oct): can the platform understand Saudi and Emirati
 * callers on `ar-SA`, in both transcription modes? No portal code is involved.
 *
 *   1. Caller lines are recorded in a native-accent voice (sample-recorder harness).
 *   2. They are joined into one track with gaps for the agent's replies.
 *   3. A throwaway agent per dialect × stt mode takes a web call from headless Chrome whose
 *      fake microphone plays that track; the transcript is saved for scoring.
 *
 *   CHROME_PATH=/usr/bin/google-chrome pnpm --filter @portal/api proof:arabic [sa|ae ...]
 *
 * Writes to `OUT` (default: a temp directory); clips are kept there and reused on a rerun.
 * Needs ffmpeg/ffprobe on PATH and the curated voices in the workspace (`voices:import`).
 * The callers are synthetic voices on a browser call — an upper bound, not a phone line.
 * Every agent and LLM it creates is deleted afterwards.
 */
import 'reflect-metadata';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RetellConfig } from '../src/modules/retell/retell.config';
import { RetellGateway } from '../src/modules/retell/retell.gateway';
import type { TierStack } from '../src/modules/retell/retell.types';
import { CURATED_VOICES } from '../src/modules/voices/curated-voices';
import { ROOT, startRecorder } from './sample-recorder';

const OUT = process.env.OUT ?? path.join(tmpdir(), 'arabic-proof');

interface Dialect {
  key: 'sa' | 'ae';
  /** Curated voice that plays the caller (`curated-voices.ts` key). */
  callerVoice: string;
  /** Curated voice the agent answers in. */
  agentVoice: string;
  lines: string[];
  prompt: string;
  greeting: string;
}

const prompt = (dialect: string, city: string, currency: string, name: string) =>
  `You are ${name}, the receptionist of "Al Noor Clinic", a fictional dental clinic in ${city}.
Speak only in everyday ${dialect}, not Modern Standard Arabic.
If the caller switches to English, answer in English, then return to Arabic when they do.

Hours: Sunday to Thursday 9am–9pm, Saturday 4pm–9pm, closed Friday.
Consultation price: 150 ${currency}. Cleaning: 300 ${currency}.

You can book, change or cancel an appointment. Ask for the caller's name, the day, the time and their mobile number.
Read the mobile number back digit by digit in Arabic and ask the caller to confirm it.
Keep every answer short: one or two sentences.
Before saying goodbye, ask whether there is anything else. Say goodbye in Arabic.`;

const DIALECTS: Dialect[] = [
  {
    key: 'sa',
    callerVoice: 'gulf-fahad',
    agentVoice: 'gulf-mona',
    lines: [
      'أبغى أحجز موعد بكرة الصبح لو سمحت',
      'وش أوقات الدوام عندكم يوم الخميس؟',
      'كم سعر الكشف عندكم؟ وكم التنظيف؟',
      'رقمي صفر خمسة خمسة، واحد اثنين ثلاثة، أربعة خمسة ستة سبعة',
      'عندي appointment الساعة four، أبغى أغيره',
      'لا، بس كذا. مشكور، مع السلامة',
    ],
    prompt: prompt('Saudi Gulf Arabic (white dialect)', 'Riyadh', 'riyals', 'Sara'),
    greeting: 'هلا والله، معك سارة من عيادة النور، كيف أقدر أساعدك؟',
  },
  {
    key: 'ae',
    callerVoice: 'gulf-sultan',
    agentVoice: 'gulf-khalifa',
    lines: [
      'أبا أحجز موعد باكر الصبح لو سمحت',
      'شو مواعيد الدوام عندكم يوم الخميس؟',
      'بكم الكشفية عندكم؟ وبكم التنظيف؟',
      'رقمي صفر خمسة صفر، واحد اثنين ثلاثة، أربعة خمسة ستة سبعة',
      'أبا أكنسل الـ booking مال باكر',
      'لا، بس جي. مشكور، فمان الله',
    ],
    prompt: prompt('Emirati Arabic', 'Dubai', 'dirhams', 'Saeed'),
    greeting: 'هلا ومرحبا، معاك سعيد من عيادة النور، شو أقدر أساعدك فيه؟',
  },
];

const MODES = ['fast', 'accurate'] as const;
/** Silence before the first line (the greeting) and after each line (the reply). */
const LEAD_S = 9;
const GAP_S = 14;

const stack = (stt: TierStack['stt_mode']): TierStack => ({
  model: 'gpt-4.1-mini',
  default_voice_id: '',
  voice_model: 'eleven_multilingual_v2',
  max_call_duration_ms: 180_000,
  denoising_mode: 'noise-cancellation',
  stt_mode: stt,
});

const ffmpeg = (...args: string[]) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
const seconds = (file: string) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

/** LEAD, line 1, GAP, line 2, GAP … as one 48 kHz mono 16-bit WAV for Chrome's fake mic. */
function callerTrack(clips: string[], out: string): number {
  const inputs: string[] = [];
  const parts: string[] = [];
  const silence = (s: number, label: string) => `anullsrc=r=48000:cl=mono,atrim=duration=${s}[${label}]`;
  const filters = [silence(LEAD_S, 'lead')];
  parts.push('[lead]');
  clips.forEach((clip, i) => {
    inputs.push('-i', clip);
    filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono[c${i}]`, silence(GAP_S, `g${i}`));
    parts.push(`[c${i}]`, `[g${i}]`);
  });
  filters.push(`${parts.join('')}concat=n=${parts.length}:v=0:a=1[out]`);
  ffmpeg(...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-c:a', 'pcm_s16le', out);
  return seconds(out);
}

async function main() {
  const only = process.argv.slice(2);
  const dialects = DIALECTS.filter((d) => !only.length || only.includes(d.key));
  const gw = new RetellGateway(new RetellConfig());
  gw.config.assertConfigured();
  mkdirSync(path.join(OUT, 'clips'), { recursive: true });
  // Curated voices have a `custom_voice_*` id of this workspace's own; find it by name.
  const listed = new Map((await gw.listVoices()).map((v) => [v.voice_name, v.voice_id]));
  const voiceId = (key: string) => {
    const curated = CURATED_VOICES.find((v) => v.key === key);
    const id = curated && listed.get(curated.platformName);
    if (!id) throw new Error(`voice ${key} is not in this workspace — run voices:import`);
    return id;
  };
  console.log(`output: ${OUT}`);

  const recorder = await startRecorder(gw, { browsers: 1 });
  const { launch } = await import(path.join(ROOT, 'frontend/web/scripts/cdp.mjs'));
  try {
    for (const d of dialects) {
      // 1. Caller lines, recorded once and kept.
      const clips: string[] = [];
      for (const [i, text] of d.lines.entries()) {
        const out = path.join(OUT, 'clips', `${d.key}-${i + 1}.mp3`);
        if (!existsSync(out)) {
          const r = await recorder.record(
            recorder.browsers[0]!,
            {
              name: `arabic-proof-caller-${d.key}-${i + 1}`,
              text,
              voiceId: voiceId(d.callerVoice),
              voiceModel: 'eleven_multilingual_v2',
              language: 'ar-SA',
              stack: stack('accurate'),
              metadata: { purpose: 'arabic_stt_proof' },
              bitrate: '96k',
            },
            out,
          );
          console.log(`[${d.key}] clip ${i + 1}: ${r.seconds.toFixed(1)} s (call ${r.callId})`);
        }
        clips.push(out);
      }
      const track = path.join(OUT, `${d.key}-caller.wav`);
      const trackS = callerTrack(clips, track);
      console.log(`[${d.key}] caller track ${trackS.toFixed(1)} s`);

      // 2. One call per transcription mode.
      for (const mode of MODES) {
        let llmId: string | null = null;
        let agentId: string | null = null;
        const browser = await launch({
          port: 9350,
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${track}%noloop`,
            '--autoplay-policy=no-user-gesture-required',
          ],
        });
        try {
          const s = stack(mode);
          llmId = (await gw.createLlm({ prompt: d.prompt, beginMessage: d.greeting, model: s.model as never })).llm_id;
          agentId = (
            await gw.createAgent({
              name: `arabic-proof-${d.key}-${mode}`,
              llmId,
              voiceId: voiceId(d.agentVoice),
              voiceModel: s.voice_model,
              language: 'ar-SA',
              maxCallDurationMs: s.max_call_duration_ms,
              denoisingMode: s.denoising_mode,
              sttMode: s.stt_mode,
            })
          ).agent_id;
          const call = await gw.createWebCall({ agentId, agentVersion: 0, metadata: { purpose: 'arabic_stt_proof' } });
          const holdMs = Math.round((trackS + 8) * 1000);

          await browser.goto('http://127.0.0.1:8765/', 1500);
          const result = (await browser.evaluate(`(async () => {
            const { RetellClient } = await import('/retell.mjs');
            const minted = ${JSON.stringify(call)};
            const client = new RetellClient({ key: 'local', fetch: async () =>
              new Response(JSON.stringify(minted), { status: 200, headers: { 'content-type': 'application/json' } }) });
            return await new Promise((resolve) => {
              let live = false;
              const s = client.createWebCall({ agent_id: minted.agent_id, transcript: false, hooks: {
                onStatus: (st) => {
                  if (st === 'live' && !live) { live = true; setTimeout(() => s.end().catch(() => s.disconnect()), ${holdMs}); }
                  if (st === 'ended') resolve({ ok: live });
                },
                onError: (e) => resolve({ ok: false, error: String(e && e.message || e) }),
              } });
              setTimeout(() => s.end().catch(() => s.disconnect()), ${holdMs + 30_000});
            });
          })()`)) as { ok: boolean; error?: string };
          if (!result?.ok) throw new Error(`call failed: ${result?.error ?? 'never went live'}`);

          let got: Record<string, unknown> | null = null;
          for (let i = 0; i < 40; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            const c = (await gw.getCall(call.call_id)) as unknown as Record<string, unknown>;
            if (c.call_status === 'ended' && c.transcript_object) {
              got = c;
              break;
            }
          }
          if (!got) throw new Error(`no transcript for ${call.call_id}`);
          const turns = (got.transcript_object as { role: string; content: string }[]).map((t) => ({ role: t.role, content: t.content }));
          writeFileSync(
            path.join(OUT, `${d.key}-${mode}.json`),
            JSON.stringify({ call_id: call.call_id, dialect: d.key, mode, expected: d.lines, turns, disconnection_reason: got.disconnection_reason, latency: got.latency }, null, 2),
          );
          console.log(`\n=== ${d.key} / ${mode} (call ${call.call_id}, ${got.disconnection_reason})`);
          for (const t of turns) console.log(`${t.role === 'agent' ? 'AGENT ' : 'CALLER'}: ${t.content}`);
        } finally {
          browser.close();
          if (agentId) await gw.deleteAgent(agentId).catch((e: Error) => console.error('agent cleanup:', e.message));
          if (llmId) await gw.deleteLlm(llmId).catch((e: Error) => console.error('llm cleanup:', e.message));
        }
      }
    }
  } finally {
    recorder.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
