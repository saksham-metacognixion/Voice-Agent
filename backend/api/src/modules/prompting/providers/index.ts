import { Logger } from '@nestjs/common';
import { resolveAppEnv } from '../../../common/env';
import { AnthropicPromptProvider } from './anthropic.provider';
import type { PromptProvider } from './prompt-provider';
import { ScriptedPromptProvider } from './scripted.provider';

export { PROMPT_PROVIDER, ProviderError, isProviderError } from './prompt-provider';
export type { PromptProvider, ProviderRequest, ProviderResult, ProviderErrorKind, ImageTranscriptionRequest } from './prompt-provider';
export { AnthropicPromptProvider, toProviderError } from './anthropic.provider';
export { ScriptedPromptProvider } from './scripted.provider';
export type { ScriptedBehaviour } from './scripted.provider';
export { GENERATED_PROMPT_JSON_SCHEMA, GENERATED_PATCH_JSON_SCHEMA } from './output-schema';

/**
 * Which provider this process runs, from the environment alone (ADR 0009: "the provider
 * must be configurable so the choice is one file to reverse").
 *
 *   GENERATION_PROVIDER=anthropic   the default — `claude-sonnet-5`, or GENERATION_MODEL
 *   GENERATION_PROVIDER=scripted    deterministic answers, for tests and a keyless dev box
 *
 * `scripted` is refused in production. An environment that quietly generated fake agents
 * because a key was missing would look exactly like a working one until a customer's
 * first real call.
 */
export function createPromptProvider(env: NodeJS.ProcessEnv = process.env): PromptProvider {
  const log = new Logger('PromptProvider');
  const choice = (env.GENERATION_PROVIDER?.trim().toLowerCase() || 'anthropic') as 'anthropic' | 'scripted';

  if (choice === 'scripted') {
    if (resolveAppEnv(env) === 'prod') {
      throw new Error('GENERATION_PROVIDER=scripted is not allowed in production — set ANTHROPIC_API_KEY instead.');
    }
    log.warn('using the scripted prompt provider: generated agents are canned text, not model output');
    return new ScriptedPromptProvider();
  }

  return new AnthropicPromptProvider(env);
}
