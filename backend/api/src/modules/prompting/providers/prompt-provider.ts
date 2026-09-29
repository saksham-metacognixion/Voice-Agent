import type { GeneratedPatch, GeneratedPrompt } from '@portal/schemas';

/**
 * The provider seam ADR 0009 asks for: `PromptingService → PromptProvider → AnthropicProvider`.
 *
 * "ADR 0001's LLM row now reads Anthropic → OpenAI → Anthropic. That chain is the argument
 * for the provider interface" — so nothing above this file knows which vendor is in play,
 * which model it runs, or what its SDK's errors look like. The generation *workflow* —
 * validate, append guardrails, lint, version, publish an event — is identical whatever
 * answers.
 *
 * Two methods, because there are two shapes of answer (§9.3 and §9.6) and the second is
 * not the first with a different prompt: it returns a patch, and "I cannot do that" is a
 * valid success.
 */
export interface PromptProvider {
  /** For logs, `jobs.steps_json` and the D5 benchmark. Never shown to a customer. */
  readonly name: string;
  readonly model: string;
  /** False when the provider has no credentials; the service fails the job with a clear reason. */
  readonly configured: boolean;

  generate(request: ProviderRequest): Promise<ProviderResult<GeneratedPrompt>>;
  patch(request: ProviderRequest): Promise<ProviderResult<GeneratedPatch>>;
  /**
   * ADR 0023 — a photo of a menu or price list, read into the plain text the brief keeps.
   * The answer is the document's words in order; `''` when the image holds no readable
   * text (the service turns that into `DOCUMENT_UNREADABLE`). Build time only, like the
   * other two: nothing here is ever in the call path.
   */
  transcribeImage(request: ImageTranscriptionRequest): Promise<ProviderResult<string>>;
}

export interface ImageTranscriptionRequest {
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Base64, no line breaks. */
  data: string;
  /** What the customer called it ("Dinner menu"), so the model knows what it is looking at. */
  name: string;
  timeoutMs?: number;
}

export interface ProviderRequest {
  system: string;
  user: string;
  /** Hard wall-clock budget for the call, retries included. §9.3 step 7: 20 s, 1 retry. */
  timeoutMs?: number;
  /**
   * Called once, when the first answer token arrives. The worker turns it into the
   * `generation_progress` frame so W2's progress bar moves when the model actually starts
   * writing, not on a timer. Must not throw; a provider that does not stream calls it
   * just before it answers.
   */
  onFirstToken?: () => void;
}

export interface ProviderResult<T> {
  value: T;
  /** Wall clock for the whole call, for the ≤ 10 s p95 exit check. */
  latencyMs: number;
  /**
   * Wall clock to the first answer token, and how much of that the model spent thinking
   * before it began to answer. Both are `undefined` for a provider that does not stream
   * (the scripted one). They tell "slow to start" apart from "long answer" — the two
   * have different fixes, and the D5 latency work needed to know which it was.
   */
  firstTokenMs?: number;
  thinkingMs?: number;
  attempts: number;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Why a generation failed, in the only terms the workflow cares about: may it be retried?
 *
 *   timeout | unavailable | rate_limited   the provider, transiently — BullMQ retries
 *   malformed | empty | invalid_output     the provider answered, wrongly — retry once,
 *                                          then fail the job; a model that returns
 *                                          unparseable JSON twice will not fix itself on
 *                                          the eighth attempt ten minutes later
 *   refused                                the model declined — never retried
 *   not_configured                         our environment — never retried
 */
export type ProviderErrorKind =
  | 'timeout'
  | 'unavailable'
  | 'rate_limited'
  | 'malformed'
  | 'empty'
  | 'invalid_output'
  | 'refused'
  | 'not_configured';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly options: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    if (options.cause !== undefined) this.cause = options.cause;
  }

  /** Whether the *job* should be retried by BullMQ, as opposed to inside the provider. */
  get retryable(): boolean {
    return this.options.retryable ?? RETRYABLE.has(this.kind);
  }
}

const RETRYABLE = new Set<ProviderErrorKind>(['timeout', 'unavailable', 'rate_limited']);

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** DI token — Nest cannot inject an interface. */
export const PROMPT_PROVIDER = Symbol('PROMPT_PROVIDER');
