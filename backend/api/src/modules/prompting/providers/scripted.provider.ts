import { Logger } from '@nestjs/common';
import {
  type BriefPatch,
  type GeneratedPatch,
  type GeneratedPrompt,
  type Weekday,
  generatedPatch,
  generatedPrompt,
  modelBriefPatch,
} from '@portal/schemas';
import { answersFromPrompt } from '../brief-answers';
import {
  type BriefAnswersRequest,
  type ImageTranscriptionRequest,
  type PromptProvider,
  ProviderError,
  type ProviderErrorKind,
  type ProviderRequest,
  type ProviderResult,
} from './prompt-provider';

/**
 * A provider that answers from a script instead of from a model.
 *
 * It exists for two reasons, and neither of them is "mocking":
 *
 *   1. **The pipeline must be testable end to end without spending money or needing a
 *      key.** Everything after the provider — zod validation, guardrail appending, §9.5
 *      lint, the version row, the Retell sync, the SSE frame — is ours, and it is the part
 *      that can be wrong. Driving it with a scripted answer tests all of it, including the
 *      paths a real model rarely takes: malformed JSON, a missing field, a refusal, a
 *      timeout, and an answer that tries to rewrite the platform guardrails.
 *   2. **`pnpm dev` without an Anthropic key still works.** `GENERATION_PROVIDER=scripted`
 *      makes the wizard complete; it is refused outright in production, where a silently
 *      fake agent would be far worse than a failed job.
 *
 * The default answer is derived deterministically from the request, so a test can assert
 * on it without pinning a paragraph of prose.
 */
export type ScriptedBehaviour =
  | { kind: 'ok'; value?: Partial<GeneratedPrompt> }
  | { kind: 'ok_patch'; value?: Partial<GeneratedPatch> }
  | { kind: 'ok_brief'; value: Record<string, unknown> }
  | { kind: 'raw'; text: string }
  | { kind: 'fail'; error: ProviderErrorKind; message?: string }
  | { kind: 'delay'; ms: number };

export class ScriptedPromptProvider implements PromptProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-v1';
  readonly configured = true;

  private readonly log = new Logger(ScriptedPromptProvider.name);
  private readonly script: ScriptedBehaviour[] = [];
  /** Every request that reached the provider — the duplicate-job assertions read this. */
  readonly calls: Array<
    | { kind: 'generate' | 'patch'; request: ProviderRequest }
    | { kind: 'transcribe'; request: ImageTranscriptionRequest }
    | { kind: 'brief'; request: BriefAnswersRequest }
  > = [];

  /** Queues one answer. Consumed in order; when the queue is empty the default is used. */
  push(...behaviours: ScriptedBehaviour[]): this {
    this.script.push(...behaviours);
    return this;
  }

  reset(): void {
    this.script.length = 0;
    this.calls.length = 0;
  }

  async generate(request: ProviderRequest): Promise<ProviderResult<GeneratedPrompt>> {
    this.calls.push({ kind: 'generate', request });
    const started = Date.now();
    const next = this.script.shift();
    await this.applyFailures(next);

    const raw =
      next?.kind === 'raw'
        ? next.text
        : JSON.stringify({ ...defaultPrompt(request), ...(next?.kind === 'ok' ? next.value : {}) });
    request.onFirstToken?.();
    return this.finish<GeneratedPrompt>(generatedPrompt, raw, started);
  }

  async patch(request: ProviderRequest): Promise<ProviderResult<GeneratedPatch>> {
    this.calls.push({ kind: 'patch', request });
    const started = Date.now();
    const next = this.script.shift();
    await this.applyFailures(next);

    const raw =
      next?.kind === 'raw'
        ? next.text
        : JSON.stringify({
            ...defaultPatch(request),
            ...(next?.kind === 'ok_patch' ? next.value : {}),
          });
    request.onFirstToken?.();
    return this.finish<GeneratedPatch>(generatedPatch, raw, started);
  }

  /** A `raw` behaviour is the transcription verbatim (`''` = no text); the default names the file. */
  async transcribeImage(request: ImageTranscriptionRequest): Promise<ProviderResult<string>> {
    this.calls.push({ kind: 'transcribe', request });
    const started = Date.now();
    const next = this.script.shift();
    await this.applyFailures(next);
    const value =
      next?.kind === 'raw'
        ? next.text
        : `${request.name.toUpperCase()}\nScripted item one $10\nScripted item two $12`;
    return { value, latencyMs: Date.now() - started, attempts: 1, model: this.model };
  }

  /**
   * ADR 0047. The default is the answers themselves, laid into their fields by fixed rules
   * (no model, no key, the same output for the same answers); `ok_brief` replaces it and
   * `raw` is whatever a model might have said. All three pass the real gate.
   */
  async briefFromAnswers(request: BriefAnswersRequest): Promise<ProviderResult<BriefPatch>> {
    this.calls.push({ kind: 'brief', request });
    const started = Date.now();
    const next = this.script.shift();
    await this.applyFailures(next);
    const raw = next?.kind === 'raw' ? next.text : JSON.stringify(next?.kind === 'ok_brief' ? next.value : defaultBrief(request));
    request.onFirstToken?.();
    return this.finish<BriefPatch>(modelBriefPatch({ answered: request.answered, country: request.country }), raw, started);
  }

  private async applyFailures(next: ScriptedBehaviour | undefined): Promise<void> {
    if (!next) return;
    if (next.kind === 'delay') {
      await new Promise((resolve) => setTimeout(resolve, next.ms));
      return;
    }
    if (next.kind === 'fail') {
      throw new ProviderError(next.error, next.message ?? `scripted ${next.error}`);
    }
  }

  /** The same parse-then-validate the real provider runs, so a scripted `raw` behaves alike. */
  private finish<T>(
    validator: {
      safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown };
    },
    raw: string,
    started: number,
  ): ProviderResult<T> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProviderError(
        'malformed',
        `scripted provider returned non-JSON: ${raw.slice(0, 120)}`,
      );
    }
    const result = validator.safeParse(parsed);
    if (!result.success || result.data === undefined) {
      throw new ProviderError(
        'invalid_output',
        `scripted provider returned an invalid object: ${String(result.error)}`,
      );
    }
    this.log.debug(`scripted answer in ${Date.now() - started} ms`);
    return {
      value: result.data as T,
      latencyMs: Date.now() - started,
      attempts: 1,
      model: this.model,
    };
  }
}

/**
 * A believable answer built from the request. It carries **no** guardrail block, exactly
 * as a real answer does not: appending them is the backend's job (§9.4).
 */
function defaultPrompt(request: ProviderRequest): GeneratedPrompt {
  const business = firstMatch(request.user, /- Business: (.+)/) ?? 'the business';
  const agentName = firstMatch(request.user, /"agent_name": "([^"]+)"/) ?? 'Sophie';

  return {
    prompt: [
      '## Identity',
      `You are ${agentName}, the receptionist for ${business}.`,
      '',
      '## Goal',
      firstMatch(request.user, /"goal": "([^"]+)"/) ?? 'Answer the call and take a message.',
      '',
      '## Conversation guide',
      '1. Greet the caller and name the business.',
      "2. Identify the caller's need in one question.",
      '3. Answer from the business facts, or take a message.',
      '4. Confirm the captured details back to the caller before ending.',
      '',
      '## Rules',
      "- If unsure, say you'll have someone call back; never invent facts.",
      '- Keep answers under 2 sentences unless asked for detail.',
      '',
      '## Hand-off',
      'When the caller asks for a person, transfer them; otherwise take a message.',
      ...readMessageRules(request.user),
      '',
      '## Ending',
      'Only once the caller says there is nothing else, thank them and end the call.',
    ].join('\n'),
    greeting: `Thank you for calling ${business}. How can I help?`,
    closing: 'Thanks for calling, goodbye.',
    brief_card: {
      does: ['Answers calls', 'Takes messages'],
      doesnt: ['Quotes prices that are not in the brief'],
      handoff: ['Transfers when the caller asks for a person'],
    },
    analysis_fields: [
      { name: 'caller_name', type: 'text', description: 'The name the caller gave.' },
      { name: 'callback_number', type: 'text', description: 'The number to call back on.' },
    ],
    scenarios: [
      {
        title: 'Asking for opening hours',
        say_this: 'We are open Monday to Friday, nine to five.',
      },
    ],
    warnings: [],
  };
}

/**
 * Each answer goes into its question's field as it was given; lists are split on commas
 * and "and". An address is what follows "located at" / "our address is", an agent name
 * what follows "call it" / "named", and an FAQ is a sentence ending in "?" with the
 * sentence after it.
 */
function defaultBrief(request: ProviderRequest): Record<string, unknown> {
  const answers = answersFromPrompt(request.user);
  const text = (id: keyof typeof answers) => answers[id]?.replace(/\s+/g, ' ').trim() || undefined;
  const handoff = text('handoff');
  const number = handoff?.match(/\+?\d[\d\s().-]{6,}\d/)?.[0];
  const restrictions = text('restrictions');
  const extra = text('extra');
  const faqs = [...(extra ?? '').matchAll(/([^.?!]+\?)\s*([^.?!]+[.!]?)/g)].map((match) => ({ question: match[1]!.trim(), answer: match[2]!.trim() }));
  const rest = faqs.length > 0 ? extra!.replace(/([^.?!]+\?)\s*([^.?!]+[.!]?)/g, ' ').replace(/\s+/g, ' ').trim() : extra;
  return {
    about_business: text('business'),
    address: text('business')?.match(/(?:located at|address is|find us at|we are at)\s+([^.]+)/i)?.[1]?.trim(),
    goal: text('role'),
    agent_name: text('role')?.match(/(?:call (?:it|her|him|the agent)|named|name is|name it)\s+([\p{L}][\p{L}'’-]*)/iu)?.[1],
    business_hours: scriptedHours(text('hours')),
    services: text('services')
      ?.split(/,|;|\band\b/i)
      .map((item) => item.trim().replace(/\.$/, ''))
      .filter(Boolean),
    pricing: text('pricing'),
    never_do: restrictions,
    never_do_presets: restrictions && /price/i.test(restrictions) ? ['no_prices'] : [],
    handoff_rules: handoff ? [{ condition: handoff, action: number ? 'transfer' : 'take_message', transfer_number: number }] : [],
    anything_else: rest || undefined,
    faqs,
  };
}

const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
const ALL_DAYS: Weekday[] = [...WEEKDAYS, 'sat', 'sun'];

/** The first "9 to 5" / "8:30am-6pm" in the answer, on weekdays, or on all seven for "every day". */
function scriptedHours(answer: string | undefined): Array<{ day: Weekday; open: string; close: string }> | undefined {
  const match = answer?.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|until|-|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!answer || !match) return undefined;
  const hour = (raw: string, meridiem: string | undefined) => {
    const h = Number(raw) % 24;
    if (meridiem?.toLowerCase() === 'pm' && h < 12) return h + 12;
    if (meridiem?.toLowerCase() === 'am' && h === 12) return 0;
    return h;
  };
  const openHour = hour(match[1]!, match[3]);
  let closeHour = hour(match[4]!, match[6]);
  if (!match[6] && closeHour <= openHour && closeHour < 12) closeHour += 12;
  const at = (h: number, minutes: string | undefined) => `${String(h).padStart(2, '0')}:${minutes ?? '00'}`;
  const interval = { open: at(openHour, match[2]), close: at(closeHour, match[5]) };
  const days = /every day|daily|seven days|7 days/i.test(answer) ? ALL_DAYS : WEEKDAYS;
  return days.map((day) => ({ day, ...interval }));
}

function defaultPatch(request: ProviderRequest): GeneratedPatch {
  const current =
    firstMatch(request.user, /# Current prompt\n```\n([\s\S]*?)\n```/) ?? 'You are a receptionist.';
  const feedback = request.user.split('# What the customer said\n').at(-1)?.trim() ?? 'be warmer';
  return {
    updated_brief: {},
    updated_prompt: `${current}\n\n## Extra instruction\n${feedback}`,
    changes: [`Applied: ${feedback.slice(0, 120)}`],
  };
}

/**
 * The brief's read-a-message rules, kept word for word as the user turn asks of a real
 * model — so the `handoff_message_missing` lint passes on scripted output too.
 */
function readMessageRules(user: string): string[] {
  const json = user.match(/# The brief\n```json\n([\s\S]*?)\n```/)?.[1];
  if (!json) return [];
  try {
    const rules = (JSON.parse(json) as { handoff_rules?: unknown }).handoff_rules;
    if (!Array.isArray(rules)) return [];
    return rules
      .filter((rule): rule is string => typeof rule === 'string' && rule.includes('word for word'))
      .map((rule) => {
        const [condition, rest = ''] = rule.split(' → ');
        const message = rest.match(/"([\s\S]*)"$/)?.[1] ?? '';
        return `When ${condition}, say exactly: "${message}"`;
      });
  } catch {
    return [];
  }
}

function firstMatch(text: string, pattern: RegExp): string | null {
  return text.match(pattern)?.[1] ?? null;
}
