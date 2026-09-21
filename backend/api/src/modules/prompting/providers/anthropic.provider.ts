import { Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream';
import { type GeneratedPatch, type GeneratedPrompt, generatedPatch, generatedPrompt } from '@portal/schemas';
import type { z } from 'zod';
import { GENERATED_PATCH_JSON_SCHEMA, GENERATED_PROMPT_JSON_SCHEMA } from './output-schema';
import {
  type PromptProvider,
  ProviderError,
  type ProviderRequest,
  type ProviderResult,
} from './prompt-provider';

/**
 * Anthropic, `claude-sonnet-5` by default (ADR 0009). The only file in the backend that
 * imports `@anthropic-ai/sdk` — the same isolation rule the Retell gateway follows.
 *
 * What ADR 0009 pins, and what this file therefore does:
 *   - structured output through `output_config.format`, **not** the deprecated
 *     `output_format` parameter and not an assistant prefill (400 on this model family);
 *   - `thinking: {type: 'adaptive'}` — `budget_tokens` is rejected on this model;
 *   - the model id comes from `GENERATION_MODEL`, so swapping to `claude-opus-5` after
 *     the benchmark is an env change, not a deploy of new logic.
 *
 * Two things here are *not* from the ADR; they are from running it
 * (`pnpm --filter @portal/api bench:generation`):
 *
 *   **It streams.** ADR 0009 assumed a non-streaming call would do — "the envelope is a
 *   few thousand tokens". In practice a non-streaming request with adaptive thinking sat
 *   open for minutes without the per-request timeout firing: the socket was alive, so
 *   nothing timed out, and the customer's ten seconds were long gone. `.stream()` +
 *   `finalMessage()` returns the same `Message` and keeps the connection producing, and
 *   the deadline below is enforced by an AbortController we own rather than by hoping.
 *
 *   **Effort is `low` by default.** ADR 0009 itself says to tune depth with
 *   `output_config.effort` if the 10 s p95 is at risk, and it is: this is well-specified
 *   structured drafting from a brief, not a problem that repays thinking. `GENERATION_EFFORT`
 *   overrides it, so raising the dial after the benchmark is an env change.
 *
 * Validation is **not** done by the SDK's parse helper: the contract is the zod schema in
 * `@portal/schemas` (ADR 0009), and that package is zod 3 while the helper wants zod 4.
 * The JSON Schema in `output-schema.ts` constrains the decoder; zod is what decides
 * whether the answer may become a version.
 */
export class AnthropicPromptProvider implements PromptProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly configured: boolean;

  private readonly log = new Logger(AnthropicPromptProvider.name);
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  /** `none` sends no `effort` at all — see the call site. */
  private readonly effort: Effort;
  /** `adaptive` or `off`. See the note on GENERATION_THINKING below. */
  private readonly thinking: 'adaptive' | 'off';
  private client?: Anthropic;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.apiKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
    this.model = env.GENERATION_MODEL?.trim() || 'claude-sonnet-5';
    // 45 s, not the 20 s §9.3 step 7 assumes. That number was written against a ≤ 10 s
    // p95; measured against `claude-sonnet-5` the p50 is ~15 s (see ADR 0012), so a 20 s
    // budget would abort and retry roughly half of all generations — doubling the cost and
    // the wait to save nothing. The job's three attempts are the real ceiling.
    this.timeoutMs = positiveInt(env.GENERATION_TIMEOUT_MS, 45_000);
    // Streaming, so a large ceiling costs nothing until it is used; the envelope is a
    // few thousand tokens and the deadline is what actually bounds the call.
    this.maxTokens = positiveInt(env.GENERATION_MAX_TOKENS, 16_000);
    this.effort = effortOf(env.GENERATION_EFFORT) ?? 'low';
    this.thinking = env.GENERATION_THINKING?.trim().toLowerCase() === 'off' ? 'off' : 'adaptive';
    this.configured = this.apiKey.length > 0;

    if (!this.configured) {
      this.log.warn('ANTHROPIC_API_KEY is not set; prompt generation will fail with a clear error (see .env.example).');
    } else {
      this.log.log(
        `generation model ${this.model}, effort ${this.effort}, thinking ${this.thinking} (timeout ${this.timeoutMs} ms)`,
      );
    }
  }

  /**
   * Built on first use, like the Retell gateway: the provider is constructed at boot in
   * both processes and a missing key must not stop either from starting.
   *
   * `maxRetries: 0` on the SDK is deliberate. Retries live one level up, where they can
   * be counted, logged into `jobs.steps_json` and stopped on a non-retryable answer; the
   * SDK's own would silently triple the wall clock against a 10 s p95 target.
   */
  private get sdk(): Anthropic {
    if (!this.configured) {
      throw new ProviderError('not_configured', 'ANTHROPIC_API_KEY is not set.');
    }
    return (this.client ??= new Anthropic({ apiKey: this.apiKey, timeout: this.timeoutMs, maxRetries: 0 }));
  }

  generate(request: ProviderRequest): Promise<ProviderResult<GeneratedPrompt>> {
    return this.call<GeneratedPrompt>(request, GENERATED_PROMPT_JSON_SCHEMA, generatedPrompt);
  }

  patch(request: ProviderRequest): Promise<ProviderResult<GeneratedPatch>> {
    return this.call<GeneratedPatch>(request, GENERATED_PATCH_JSON_SCHEMA, generatedPatch);
  }

  /**
   * One structured-output call, parsed and validated.
   *
   * The retry here is the §9.3 "1 retry" and only fires for a transient failure: a
   * timeout, a 429 or a 5xx. A malformed answer is *not* retried in-process — it is
   * thrown as a non-retryable ProviderError so the job records what came back and fails
   * visibly, rather than burning the customer's ten seconds twice on a model that has
   * already shown it cannot answer this brief.
   */
  private async call<T>(
    request: ProviderRequest,
    schema: object,
    validator: z.ZodTypeAny,
  ): Promise<ProviderResult<T>> {
    const started = Date.now();
    const timeout = request.timeoutMs ?? this.timeoutMs;
    let attempts = 0;
    let lastTransient: ProviderError | undefined;

    while (attempts < 2) {
      attempts += 1;
      const remaining = timeout - (Date.now() - started);
      if (remaining <= 250) {
        throw lastTransient ?? new ProviderError('timeout', `generation exceeded its ${timeout} ms budget`);
      }

      // Our own deadline, not the SDK's. A request that keeps its socket alive without
      // finishing is exactly the failure this is for: the abort fires on wall clock.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), remaining);

      try {
        const stream = this.sdk.messages.stream(
          {
            model: this.model,
            max_tokens: this.maxTokens,
            system: request.system,
            messages: [{ role: 'user', content: request.user }],
            // `off` has to be said, not left out: on this model family an absent `thinking`
            // parameter *runs adaptive thinking*. The 17 Sep "thinking off" measurement in
            // ADR 0012 omitted the parameter and so compared adaptive with adaptive; the
            // 21 Sep re-run with `disabled` is the real number.
            thinking: this.thinking === 'off' ? { type: 'disabled' as const } : { type: 'adaptive' as const },
            output_config: {
              // `none` omits the parameter entirely. Not a style choice: Haiku 4.5 answers
              // 400 "This model does not support the effort parameter", so without this
              // the `GENERATION_MODEL` seam only reaches the models that happen to take
              // the same knobs as Sonnet. Benchmarking an alternative was supposed to be
              // an env change (ADR 0009); this is what makes that true.
              ...(this.effort === 'none' ? {} : { effort: this.effort }),
              format: { type: 'json_schema', schema: schema as Record<string, unknown> },
            },
          },
          { timeout: remaining, signal: deadline.signal },
        );
        const timing = watchStream(stream, started, request.onFirstToken);
        const message = await stream.finalMessage();

        if (message.stop_reason === 'refusal') {
          throw new ProviderError('refused', 'The model declined to write this prompt.');
        }
        if (message.stop_reason === 'max_tokens') {
          throw new ProviderError('malformed', 'The model ran out of output tokens before finishing the prompt.');
        }

        return {
          value: validate<T>(validator, textOf(message)),
          latencyMs: Date.now() - started,
          firstTokenMs: timing.firstTokenMs,
          thinkingMs: timing.thinkingMs ?? 0,
          attempts,
          model: message.model ?? this.model,
          usage: { input_tokens: message.usage?.input_tokens, output_tokens: message.usage?.output_tokens },
        };
      } catch (error) {
        const mapped = deadline.signal.aborted
          ? new ProviderError('timeout', `generation exceeded its ${timeout} ms budget`, { cause: error })
          : toProviderError(error);
        if (!mapped.retryable || attempts >= 2) throw mapped;
        lastTransient = mapped;
        this.log.warn(`generation attempt ${attempts} failed (${mapped.kind}): ${mapped.message}; retrying once`);
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastTransient ?? new ProviderError('unavailable', 'generation failed');
  }
}

/**
 * Time-to-first-token and thinking time, read off the stream as it arrives.
 *
 * `started` is the *call's* start, retries included, so what is reported is the wait the
 * customer had, not the attempt's. Thinking time is the wall clock between a thinking
 * block opening and closing — summed, should the model think more than once — and is
 * zero when no thinking block arrives. Both are diagnostics for `jobs.steps_json`; nothing
 * here changes the answer.
 */
function watchStream(
  stream: MessageStream,
  started: number,
  onFirstToken?: () => void,
): { firstTokenMs?: number; thinkingMs?: number } {
  const timing: { firstTokenMs?: number; thinkingMs?: number } = {};
  let thinkingIndex: number | undefined;
  let thinkingStartedAt = 0;

  stream.on('streamEvent', (event) => {
    if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
      thinkingIndex = event.index;
      thinkingStartedAt = Date.now();
    } else if (event.type === 'content_block_stop' && event.index === thinkingIndex) {
      timing.thinkingMs = (timing.thinkingMs ?? 0) + (Date.now() - thinkingStartedAt);
      thinkingIndex = undefined;
    }
  });
  stream.on('text', () => {
    if (timing.firstTokenMs !== undefined) return;
    timing.firstTokenMs = Date.now() - started;
    try {
      onFirstToken?.();
    } catch {
      // A progress signal must never fail the generation.
    }
  });
  return timing;
}

/** Concatenates the text blocks. Thinking blocks are skipped — they are not the answer. */
function textOf(message: Anthropic.Message): string {
  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text.trim()) {
    throw new ProviderError('empty', 'The model returned no content.');
  }
  return text;
}

/**
 * Parse, then validate. Both failures are the same class of problem — the model answered
 * something we cannot use — but they are told apart in the error text because "the JSON
 * did not parse" and "the JSON was missing `greeting`" send an engineer to different
 * places.
 */
function validate<T>(validator: z.ZodTypeAny, raw: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderError('malformed', `The model returned text that is not JSON: ${raw.slice(0, 200)}`);
  }

  const result = validator.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ProviderError('invalid_output', `The generated prompt did not match the expected shape — ${issues}`);
  }
  // The schema *is* the type — `generatedPrompt` infers `GeneratedPrompt` — but zod's
  // output and input types differ wherever a field has a default, and a generic bound to
  // `z.ZodType<T>` picks the wrong one. The parse is the check; this cast only names it.
  return result.data as T;
}

/** SDK exception classes → the four words the workflow understands. */
export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError('timeout', 'The generation service did not answer in time.', { cause: error });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError('rate_limited', 'The generation service is rate limiting us.', { status: 429, cause: error });
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError('not_configured', 'The generation service rejected our credentials.', {
      status: error.status,
      cause: error,
    });
  }
  if (error instanceof Anthropic.BadRequestError) {
    // Our request, not their outage: a schema the model cannot satisfy, or a parameter
    // this model rejects. Retrying it produces the same 400.
    return new ProviderError('invalid_output', `The generation request was rejected: ${error.message}`, {
      status: error.status,
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError('unavailable', 'The generation service could not be reached.', { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return new ProviderError(status >= 500 ? 'unavailable' : 'invalid_output', `Generation failed (HTTP ${status}).`, {
      status,
      retryable: status >= 500,
      cause: error,
    });
  }
  if (error instanceof Error && /abort|timeout/i.test(error.message)) {
    return new ProviderError('timeout', 'The generation service did not answer in time.', { cause: error });
  }
  return new ProviderError('unavailable', error instanceof Error ? error.message : String(error), { cause: error });
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw?.trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

function effortOf(raw: string | undefined): Effort | undefined {
  const value = raw?.trim().toLowerCase() as Effort | undefined;
  return value && EFFORTS.includes(value) ? value : undefined;
}
