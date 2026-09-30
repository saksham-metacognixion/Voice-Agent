/* eslint-disable no-console */
/**
 * Records the W1 "Hear a sample" clips (`templates/*.json` → `sample_audio_url`) on our own
 * voice stack, so a clip sounds like the product and never like the vendor's catalogue.
 *
 *   pnpm --filter @portal/api samples:templates             # every template
 *   pnpm --filter @portal/api samples:templates restaurant  # just the named ones
 *
 * Per template: a throwaway agent whose begin message is the script below, on the
 * template's tier (model and voice model from `agent_stack_configs`), recorded by
 * `sample-recorder.ts` into `frontend/web/public/samples/<id>.mp3`.
 *
 * Why not a text-to-speech call: there is no TTS route (ADR 0003 §9), and the vendor's own
 * preview clips say its name (ADR 0020 §5). A call recording is audio of ours. The scripts
 * name only fictional businesses. Costs a few cents of call time per clip; no number is
 * bought. Needs `RETELL_API_KEY`, Postgres (the tier stack), Chrome and ffmpeg.
 */
import 'reflect-metadata';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { adminDb } from '@portal/db';
import { agentStackTiers } from '../src/modules/retell/retell.types';
import { RetellConfig } from '../src/modules/retell/retell.config';
import { RetellGateway } from '../src/modules/retell/retell.gateway';
import { ROOT, startRecorder } from './sample-recorder';

const OUT_DIR = path.join(ROOT, 'frontend/web/public/samples');

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

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const ids = only.length ? only : Object.keys(SAMPLES);
  for (const id of ids) if (!SAMPLES[id]) throw new Error(`no sample script for template "${id}"`);

  const gw = new RetellGateway(new RetellConfig());
  gw.config.assertConfigured();
  const row = await adminDb.agentStackConfig.findFirst({ orderBy: { version: 'desc' } });
  if (!row) throw new Error('agent_stack_configs is empty — run pnpm db:seed');
  const tiers = agentStackTiers.parse(row.tiersJson);

  mkdirSync(OUT_DIR, { recursive: true });
  const recorder = await startRecorder(gw);
  const browser = recorder.browsers[0]!;
  const failed: string[] = [];
  try {
    for (const id of ids) {
      const template = JSON.parse(readFileSync(path.join(ROOT, 'templates', `${id}.json`), 'utf8')) as {
        default_tier: 'standard' | 'premium';
      };
      const stack = tiers[template.default_tier];
      const sample = SAMPLES[id]!;
      try {
        console.log(`\n[${id}] ${template.default_tier}, ${sample.voice}`);
        const out = path.join(OUT_DIR, `${id}.mp3`);
        const { callId, seconds } = await recorder.record(
          browser,
          {
            name: `sample-${id}`,
            text: sample.text,
            voiceId: sample.voice,
            voiceModel: stack.voice_model ?? null,
            language: 'en-US',
            stack,
            metadata: { purpose: 'template_sample', template_id: id },
          },
          out,
        );
        console.log(`[${id}] call ${callId} → ${path.relative(ROOT, out)} (${seconds.toFixed(1)} s)`);
      } catch (error) {
        failed.push(id);
        console.error(`[${id}] FAILED:`, error instanceof Error ? error.message : error);
      }
    }
  } finally {
    if (browser.logs.length) console.log('\nbrowser:', browser.logs.slice(-10).join('\n'));
    recorder.close();
    await adminDb.$disconnect();
  }
  if (failed.length) {
    console.error(`\nfailed: ${failed.join(', ')}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
