import { describe, expect, it } from 'vitest';
import { AnthropicPromptProvider } from './anthropic.provider';

/*
 * The thinking default (ADR 0038, audit Z-14): off unless `GENERATION_THINKING=adaptive`.
 * Adaptive thinking cost 1.2 s of p95 on 4 Nov and changed no check, and on this model family
 * an *absent* `thinking` parameter runs adaptive, so "off" has to be sent as `disabled`.
 * The SDK client is replaced by one that records the request; nothing leaves the process.
 */
function providerWith(env: Record<string, string>) {
  const sent: Array<Record<string, unknown>> = [];
  const provider = new AnthropicPromptProvider({ ANTHROPIC_API_KEY: 'test-key', ...env } as NodeJS.ProcessEnv);
  const message = { content: [{ type: 'text', text: 'Soup of the day $6' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };
  (provider as unknown as { client: unknown }).client = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        sent.push(params);
        return { finalMessage: async () => message };
      },
    },
  };
  return { provider, sent };
}

const image = { mediaType: 'image/jpeg' as const, data: 'AAAA', name: 'menu.jpg' };

describe('GENERATION_THINKING (ADR 0038)', () => {
  it('sends thinking disabled when the variable is unset', async () => {
    const { provider, sent } = providerWith({});
    await provider.transcribeImage(image);
    expect(sent[0]?.thinking).toEqual({ type: 'disabled' });
  });

  it('sends adaptive only when asked for, in any case', async () => {
    const { provider, sent } = providerWith({ GENERATION_THINKING: ' Adaptive ' });
    await provider.transcribeImage(image);
    expect(sent[0]?.thinking).toEqual({ type: 'adaptive' });
  });

  it('treats off, and anything it does not know, as off', async () => {
    for (const value of ['off', 'OFF', 'maybe']) {
      const { provider, sent } = providerWith({ GENERATION_THINKING: value });
      await provider.transcribeImage(image);
      expect(sent[0]?.thinking, value).toEqual({ type: 'disabled' });
    }
  });
});
