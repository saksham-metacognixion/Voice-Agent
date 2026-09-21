import { Logger } from '@nestjs/common';
import { type GeneratedPatch, type GeneratedPrompt, generatedPatch, generatedPrompt } from '@portal/schemas';
import {
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
  readonly calls: Array<{ kind: 'generate' | 'patch'; request: ProviderRequest }> = [];

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

    const raw = next?.kind === 'raw' ? next.text : JSON.stringify({ ...defaultPrompt(request), ...(next?.kind === 'ok' ? next.value : {}) });
    request.onFirstToken?.();
    return this.finish<GeneratedPrompt>(generatedPrompt, raw, started);
  }

  async patch(request: ProviderRequest): Promise<ProviderResult<GeneratedPatch>> {
    this.calls.push({ kind: 'patch', request });
    const started = Date.now();
    const next = this.script.shift();
    await this.applyFailures(next);

    const raw = next?.kind === 'raw' ? next.text : JSON.stringify({ ...defaultPatch(request), ...(next?.kind === 'ok_patch' ? next.value : {}) });
    request.onFirstToken?.();
    return this.finish<GeneratedPatch>(generatedPatch, raw, started);
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
    validator: { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } },
    raw: string,
    started: number,
  ): ProviderResult<T> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProviderError('malformed', `scripted provider returned non-JSON: ${raw.slice(0, 120)}`);
    }
    const result = validator.safeParse(parsed);
    if (!result.success || result.data === undefined) {
      throw new ProviderError('invalid_output', `scripted provider returned an invalid object: ${String(result.error)}`);
    }
    this.log.debug(`scripted answer in ${Date.now() - started} ms`);
    return { value: result.data as T, latencyMs: Date.now() - started, attempts: 1, model: this.model };
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
      '',
      '## Ending',
      'Thank the caller and end the call.',
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
    scenarios: [{ title: 'Asking for opening hours', say_this: 'We are open Monday to Friday, nine to five.' }],
    warnings: [],
  };
}

function defaultPatch(request: ProviderRequest): GeneratedPatch {
  const current = firstMatch(request.user, /# Current prompt\n```\n([\s\S]*?)\n```/) ?? 'You are a receptionist.';
  const feedback = request.user.split('# What the customer said\n').at(-1)?.trim() ?? 'be warmer';
  return {
    updated_brief: {},
    updated_prompt: `${current}\n\n## Extra instruction\n${feedback}`,
    changes: [`Applied: ${feedback.slice(0, 120)}`],
  };
}

function firstMatch(text: string, pattern: RegExp): string | null {
  return text.match(pattern)?.[1] ?? null;
}
