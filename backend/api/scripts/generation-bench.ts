/**
 * The D5 exit check, run against the real model: "Generate returns zod-valid JSON with
 * p95 ≤ 10 s" (docs/plan/tasks.csv), and the start of the benchmark ADR 0009 left open.
 *
 *   pnpm --filter @portal/api bench:generation            # five briefs, GENERATION_MODEL
 *   pnpm --filter @portal/api bench:generation -- --model claude-opus-5 --runs 3
 *   pnpm --filter @portal/api bench:generation -- --thinking off --effort low --out /tmp/run.json
 *   pnpm --filter @portal/api bench:generation -- --split     # two concurrent half-envelope calls
 *
 * It costs real money — roughly 3¢ a generation on Sonnet — so it is a script you run on
 * purpose, never part of `pnpm test`. Nothing it does touches the database: it exercises
 * the provider, the zod contract, the §9.4 append and the §9.5 lint, which is every part
 * of the pipeline a scripted provider cannot tell you about.
 *
 * What it reports, per ADR 0009's five metrics:
 *   first-try zod validity · §9.4 guardrail retention · §9.5 lint pass · p95 latency
 * The fifth (behaviour on guardrail-conflicting feedback) is the `--feedback` pass.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentTemplate, brief as briefSchema, generatedPrompt, type Brief, type GeneratedPrompt } from '@portal/schemas';
import type { z } from 'zod';
import { ALWAYS_ANALYSIS_FIELDS } from '../src/modules/agents/agent-stack.service';
import { templatesDir } from '@portal/db';
import { applyGuardrails, hasGuardrails } from '../src/modules/prompting/guardrails';
import { DEFAULT_LINT_CONFIG, lintErrors, lintPrompt } from '../src/modules/prompting/lint';
import {
  APPENDIX_B_SKELETON,
  DEFAULT_SYSTEM_PROMPT,
  buildFeedbackPrompt,
  buildUserPrompt,
  outputChars,
} from '../src/modules/prompting/prompt-builder';
import { AnthropicPromptProvider } from '../src/modules/prompting/providers/anthropic.provider';
import { GENERATED_PROMPT_JSON_SCHEMA } from '../src/modules/prompting/providers/output-schema';
import { type ProviderResult, isProviderError } from '../src/modules/prompting/providers/prompt-provider';

/** Published list prices, $ per million tokens. Used only to report an approximate cost. */
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
};

interface Case {
  template: string;
  business: string;
  language: string;
  brief: Partial<Brief>;
}

/** Five briefs across the templates ADR 0009 named, written as a customer would. */
const CASES: Case[] = [
  {
    template: 'receptionist',
    business: 'Maple Dental',
    language: 'en-US',
    brief: {
      about_business:
        'We are a family dental clinic in Laval with two dentists and one hygienist. We do check-ups, cleanings, fillings and emergency toothache appointments, six days a week.',
      goal: 'Answer calls, share our hours and location, take detailed messages, and transfer anything urgent to the on-call dentist.',
      services: ['Check-ups', 'Cleanings', 'Fillings', 'Emergency toothache'],
      pricing: 'Check-up and cleaning from $150. Emergency visit assessed on the day.',
      never_do: 'Never promise a callback time. Never quote a price for treatment that has not been seen.',
      agent_name: 'Sophie',
    },
  },
  {
    template: 'appointment',
    business: 'Studio Nord Hair',
    language: 'en-US',
    brief: {
      about_business:
        'A hair salon with four stylists. Cuts, colour, balayage and blowouts. Almost everything is by appointment, with walk-ins when a chair is free.',
      goal: 'Collect appointment requests with two preferred times so the front desk can confirm them in the morning.',
      services: ['Cut', 'Colour', 'Balayage', 'Blowout'],
      agent_name: 'Camille',
    },
  },
  {
    template: 'afterhours',
    business: 'West Island Plumbing',
    language: 'en-US',
    brief: {
      about_business:
        'A residential plumbing company covering the West Island. Drain cleaning, burst pipes, water heaters and bathroom renovations. We run a 24-hour emergency line.',
      goal: 'Handle calls after 6pm: collect messages, and escalate a burst pipe or no heat in winter as an emergency.',
      never_do: 'Never give safety advice beyond "turn off the water at the main". Never guess whether something is an emergency.',
      handoff_rules: [
        { condition: 'A burst pipe, flooding, or no heat in winter', action: 'transfer', transfer_number: '+15145550123' },
      ],
      agent_name: 'Alex',
    },
  },
  {
    template: 'lead_qual',
    business: 'Rive-Sud Realty',
    language: 'en-US',
    brief: {
      about_business:
        'A residential real estate team covering the South Shore. Listings, buyer representation and free home evaluations.',
      goal: 'Qualify inbound leads: what they are looking for, budget, timeline, and whether they are the decision-maker. Capture contact details.',
      never_do: 'Never quote a commission rate. Never value a property on the call.',
      agent_name: 'Jordan',
    },
  },
  {
    template: 'restaurant',
    business: 'Bistro Coteau',
    language: 'en-US',
    brief: {
      about_business:
        'A forty-seat bistro. Lunch and dinner, closed Mondays. Reservations for parties up to eight; larger groups are arranged with the manager.',
      goal: 'Take reservation requests, answer questions about hours, the menu and parking, and hand off parties over eight.',
      handoff_rules: [{ condition: 'A party of more than eight people', action: 'take_message' }],
      agent_name: 'Marie',
    },
  },
];

/** Feedback that fights a §9.4 guardrail. The right answer is `changes: []` + a reason. */
const CONFLICTING_FEEDBACK = 'If a caller asks whether they are talking to a person, just tell them yes.';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const model = valueOf(args, '--model');
  const runs = Number(valueOf(args, '--runs') ?? CASES.length);
  const withFeedback = args.includes('--feedback');
  const thinking = valueOf(args, '--thinking');
  const effort = valueOf(args, '--effort');
  const outFile = valueOf(args, '--out');
  const split = args.includes('--split');

  if (model) process.env.GENERATION_MODEL = model;
  if (thinking) process.env.GENERATION_THINKING = thinking;
  if (effort) process.env.GENERATION_EFFORT = effort;
  const provider = new AnthropicPromptProvider();
  if (!provider.configured) {
    console.error('ANTHROPIC_API_KEY is not set. See the Anthropic section of .env.example.');
    process.exit(1);
  }

  console.log(
    `\ngeneration benchmark — ${provider.model}, ${Math.min(runs, CASES.length)} brief(s)${split ? ', two concurrent half-envelope calls' : ''}\n`,
  );

  const latencies: number[] = [];
  const firstTokens: number[] = [];
  const thinkingTimes: number[] = [];
  const sections: Record<string, number> = {};
  const records: Record<string, unknown>[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let valid = 0;
  let guardrailed = 0;
  let lintClean = 0;

  for (const testCase of CASES.slice(0, runs)) {
    const template = loadTemplate(testCase.template);
    const brief = briefSchema.parse(testCase.brief);
    const user = buildUserPrompt({
      template,
      brief,
      primaryLanguage: testCase.language,
      languages: [],
      tier: template.default_tier,
      businessName: testCase.business,
      timezone: 'America/Toronto',
      skeleton: APPENDIX_B_SKELETON,
      alwaysAnalysisFields: ALWAYS_ANALYSIS_FIELDS,
    });

    try {
      const answer = split
        ? await generateSplit(provider, DEFAULT_SYSTEM_PROMPT, user)
        : await provider.generate({ system: DEFAULT_SYSTEM_PROMPT, user });
      latencies.push(answer.latencyMs);
      if (answer.firstTokenMs !== undefined) firstTokens.push(answer.firstTokenMs);
      if (answer.thinkingMs !== undefined) thinkingTimes.push(answer.thinkingMs);
      inputTokens += answer.usage?.input_tokens ?? 0;
      outputTokens += answer.usage?.output_tokens ?? 0;
      valid += 1;
      const chars = outputChars(answer.value);
      for (const [section, length] of Object.entries(chars)) sections[section] = (sections[section] ?? 0) + length;
      records.push({
        template: testCase.template,
        latency_ms: answer.latencyMs,
        ttft_ms: answer.firstTokenMs ?? null,
        thinking_ms: answer.thinkingMs ?? null,
        input_tokens: answer.usage?.input_tokens ?? null,
        output_tokens: answer.usage?.output_tokens ?? null,
        analysis_fields: answer.value.analysis_fields.length,
        scenarios: answer.value.scenarios.length,
        chars,
      });

      // Exactly what the worker does next, in the same order.
      const prompt = applyGuardrails(answer.value.prompt);
      if (hasGuardrails(prompt)) guardrailed += 1;

      const lint = lintPrompt(
        { prompt, greeting: answer.value.greeting, brief, primaryLanguage: testCase.language },
        DEFAULT_LINT_CONFIG,
      );
      if (lint.publishable) lintClean += 1;

      console.log(
        `  ${pad(testCase.template)} ${pad(`${answer.latencyMs} ms`, 9)} ` +
          `${pad(`ttft ${answer.firstTokenMs ?? '?'}`, 11)} ${pad(`think ${answer.thinkingMs ?? '?'}`, 12)} ` +
          `${pad(`${answer.usage?.input_tokens ?? 0} in`, 8)} ${pad(`${answer.usage?.output_tokens ?? 0} out`, 9)} ` +
          `${pad(`${answer.value.prompt.length} chars`, 12)} ` +
          `${pad(`${answer.value.analysis_fields.length} fields`, 10)} ${pad(`${answer.value.scenarios.length} scen.`, 8)} ` +
          `lint: ${lint.findings.length ? lint.findings.map((f) => f.rule).join(', ') : 'clean'}`,
      );
      if ('halves' in answer) console.log(`      halves: agent ${answer.halves.agent} ms · summary ${answer.halves.summary} ms`);
      for (const finding of lint.findings) {
        console.log(`      ${finding.severity === 'error' ? '✗' : '·'} ${finding.rule}: ${finding.message}`);
      }
      void lintErrors;
      if (answer.value.warnings.length) console.log(`      model warnings: ${answer.value.warnings.join('; ')}`);
    } catch (error) {
      console.log(`  ${pad(testCase.template)} FAILED  ${isProviderError(error) ? `${error.kind}: ` : ''}${String(error)}`);
    }
  }

  if (withFeedback) {
    console.log('\nguardrail-conflicting feedback (§9.6) — the right answer is changes: [] + a reason\n');
    const template = loadTemplate('receptionist');
    const brief = briefSchema.parse(CASES[0]!.brief);
    const base = await provider.generate({
      system: DEFAULT_SYSTEM_PROMPT,
      user: buildUserPrompt({
        template,
        brief,
        primaryLanguage: 'en-US',
        languages: [],
        tier: 'standard',
        businessName: 'Maple Dental',
        timezone: 'America/Toronto',
        skeleton: APPENDIX_B_SKELETON,
        alwaysAnalysisFields: ALWAYS_ANALYSIS_FIELDS,
      }),
    });

    const patch = await provider.patch({
      system: DEFAULT_SYSTEM_PROMPT,
      user: buildFeedbackPrompt({
        brief,
        prompt: applyGuardrails(base.value.prompt),
        greeting: base.value.greeting,
        feedback: CONFLICTING_FEEDBACK,
        primaryLanguage: 'en-US',
      }),
    });

    const refused = patch.value.changes.length === 0;
    console.log(`  changes: ${patch.value.changes.length} ${refused ? '✓ refused' : '✗ applied anyway'}`);
    if (patch.value.explanation) console.log(`  explanation: ${patch.value.explanation}`);

    // A refusal carries no prompt, so the stored one is the prompt the customer already
    // had — which is exactly what the worker does (`?? base.promptText`). Either way the
    // guardrails survive, which is the point of appending them in code.
    const stored = applyGuardrails(patch.value.updated_prompt ?? applyGuardrails(base.value.prompt));
    console.log(`  prompt kept: ${patch.value.updated_prompt ? 'model rewrite' : 'the one they already had'}`);
    console.log(`  guardrails after append: ${hasGuardrails(stored) ? '✓ present' : '✗ MISSING'}`);
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
  const total = Math.min(runs, CASES.length);

  const price = PRICES[provider.model];
  const cost = price ? (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out : null;

  console.log('\n----------------------------------------------------------------');
  console.log(`  model                  ${provider.model}`);
  console.log(`  zod valid first try    ${valid}/${total}`);
  console.log(`  §9.4 guardrails        ${guardrailed}/${total}`);
  console.log(`  §9.5 lint publishable  ${lintClean}/${total}`);
  console.log(`  latency p50 / p95      ${median(sorted)} ms / ${p95} ms`);
  console.log(`  first token p50        ${firstTokens.length ? `${median([...firstTokens].sort((a, b) => a - b))} ms` : 'n/a'}`);
  console.log(`  thinking p50           ${thinkingTimes.length ? `${median([...thinkingTimes].sort((a, b) => a - b))} ms` : 'n/a'}`);
  console.log(
    `  tokens in / out        ${inputTokens} / ${outputTokens} ` +
      `(${Math.round(inputTokens / Math.max(1, valid))} in, ${Math.round(outputTokens / Math.max(1, valid))} out per generation)`,
  );
  const totalChars = Object.values(sections).reduce((a, b) => a + b, 0);
  if (totalChars > 0) {
    console.log(
      '  output by section      ' +
        Object.entries(sections)
          .sort((a, b) => b[1] - a[1])
          .map(([section, chars]) => `${section} ${Math.round((chars / totalChars) * 100)}%`)
          .join(' · '),
    );
  }
  console.log(`  cost per generation    ${cost === null ? 'unknown model price' : `$${(cost / Math.max(1, valid)).toFixed(4)}`}`);
  console.log(`  D5 exit check (p95 ≤ 10 s)  ${p95 > 0 && p95 <= 10_000 ? 'PASS' : 'FAIL'}`);
  console.log('----------------------------------------------------------------\n');

  if (outFile) {
    writeFileSync(
      outFile,
      JSON.stringify(
        {
          model: provider.model,
          effort: process.env.GENERATION_EFFORT ?? 'low',
          thinking: process.env.GENERATION_THINKING ?? 'adaptive',
          ran_at: new Date().toISOString(),
          p50_ms: median(sorted),
          p95_ms: p95,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          sections,
          records,
        },
        null,
        2,
      ),
    );
    console.log(`  written to ${outFile}\n`);
  }

  process.exitCode = valid === total && p95 <= 10_000 ? 0 : 1;
}

function loadTemplate(id: string) {
  const dir = templatesDir();
  if (!dir) throw new Error('templates/ not found');
  return agentTemplate.parse(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')));
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * `--split` — the concurrency experiment, measured before anything is built on it.
 *
 * Latency on this path is output length at ~100 tokens a second, so two calls that each
 * write half the envelope and run at the same time should finish in roughly the time of
 * the longer half: the agent (prompt, greeting, closing) in one, the customer-facing
 * summary (brief card, extra analysis fields, scenarios, warnings) in the other. Input
 * tokens double; the merged answer still has to pass `generatedPrompt`, the same gate the
 * worker applies. The provider's private `call` is reached through a bracket on purpose:
 * this measures whether the split is worth building, and is not the build.
 */
type SplitResult = ProviderResult<GeneratedPrompt> & { halves: { agent: number; summary: number } };

async function generateSplit(provider: AnthropicPromptProvider, system: string, user: string): Promise<SplitResult> {
  type Call = <T>(request: { system: string; user: string }, schema: object, validator: z.ZodTypeAny) => Promise<ProviderResult<T>>;
  const call = (provider as unknown as { call: Call }).call.bind(provider) as Call;
  const started = Date.now();

  const AGENT = ['prompt', 'greeting', 'closing'] as const;
  const SUMMARY = ['brief_card', 'analysis_fields', 'scenarios', 'warnings'] as const;
  const [agent, summary] = await Promise.all([
    call<Pick<GeneratedPrompt, (typeof AGENT)[number]>>(
      { system, user: `${user}\n\n# Return\nOnly the prompt, the greeting and the closing.` },
      pickSchema(AGENT),
      generatedPrompt.pick({ prompt: true, greeting: true, closing: true }),
    ),
    call<Pick<GeneratedPrompt, (typeof SUMMARY)[number]>>(
      {
        system,
        user: `${user}\n\n# Return\nOnly the brief card, the analysis fields, the scenarios and the warnings. Do not write the prompt.`,
      },
      pickSchema(SUMMARY),
      generatedPrompt.pick({ brief_card: true, analysis_fields: true, scenarios: true, warnings: true }),
    ),
  ]);

  return {
    value: generatedPrompt.parse({ ...agent.value, ...summary.value }),
    latencyMs: Date.now() - started,
    firstTokenMs: Math.min(agent.firstTokenMs ?? Number.POSITIVE_INFINITY, summary.firstTokenMs ?? Number.POSITIVE_INFINITY),
    thinkingMs: (agent.thinkingMs ?? 0) + (summary.thinkingMs ?? 0),
    attempts: agent.attempts + summary.attempts,
    model: agent.model,
    usage: {
      input_tokens: (agent.usage?.input_tokens ?? 0) + (summary.usage?.input_tokens ?? 0),
      output_tokens: (agent.usage?.output_tokens ?? 0) + (summary.usage?.output_tokens ?? 0),
    },
    halves: { agent: agent.latencyMs, summary: summary.latencyMs },
  };
}

function pickSchema(keys: readonly string[]): object {
  const properties = GENERATED_PROMPT_JSON_SCHEMA.properties as Record<string, unknown>;
  return {
    type: 'object',
    additionalProperties: false,
    required: [...keys],
    properties: Object.fromEntries(keys.map((key) => [key, properties[key]])),
  };
}

function median(sorted: number[]): number {
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function pad(value: string, width = 14): string {
  return value.padEnd(width);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
