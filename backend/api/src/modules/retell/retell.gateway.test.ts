import { describe, expect, it, vi } from 'vitest';
import { RetellConfig } from './retell.config';
import { RetellGateway, clampDuration } from './retell.gateway';
import { stackFor } from './retell.types';

const env = {
  RETELL_API_KEY: 'key_test_0123456789abcdef',
  API_PUBLIC_URL: 'https://api.example.test/',
  APP_ENV: 'dev',
};

function gateway(overrides: Partial<typeof env> = {}) {
  return new RetellGateway(new RetellConfig({ ...env, ...overrides }));
}

describe('RetellConfig', () => {
  it('builds both webhook URLs from API_PUBLIC_URL without a double slash', () => {
    const config = new RetellConfig(env);
    expect(config.agentWebhookUrl).toBe('https://api.example.test/webhooks/retell');
    expect(config.inboundWebhookUrl('num_0123456789')).toBe(
      'https://api.example.test/webhooks/retell/inbound/num_0123456789',
    );
  });

  it('refuses a number token short enough to guess', () => {
    expect(() => new RetellConfig(env).inboundWebhookUrl('abc')).toThrow(/number_token/);
  });

  it('prefixes object names with the environment outside prod', () => {
    expect(new RetellConfig(env).objectName('Maple Dental')).toBe('dev-Maple Dental');
    expect(new RetellConfig({ ...env, APP_ENV: 'staging' }).objectName('x')).toBe('staging-x');
    expect(new RetellConfig({ ...env, APP_ENV: 'prod' }).objectName('x')).toBe('x');
  });

  it('refuses a plaintext callback URL in prod', () => {
    expect(() => new RetellConfig({ ...env, APP_ENV: 'prod', API_PUBLIC_URL: 'http://api.example.test' })).toThrow(
      /https/,
    );
  });

  it('boots without an API key and records what is missing, so the rest of the API still starts', () => {
    const config = new RetellConfig({ ...env, RETELL_API_KEY: '' });
    expect(config.configured).toBe(false);
    expect(config.missing).toEqual(['RETELL_API_KEY']);
    expect(() => config.assertConfigured()).toThrow(/RETELL_API_KEY/);
  });

  it('fails on first Retell use, not at construction, when unconfigured', async () => {
    const gw = gateway({ RETELL_API_KEY: '' });
    expect(() => gw.client).toThrow(/not configured.*RETELL_API_KEY/);
    // The SDK accessor throws synchronously, before a request or a promise exists.
    expect(() => gw.listVoices()).toThrow(/RETELL_API_KEY/);
    expect(() => gw.signWebhookBody('{}')).toThrow(/RETELL_API_KEY/);
    // Verification never throws — it is on the webhook path — but it refuses, not accepts.
    await expect(gw.verifyWebhookSignature('{}', 'v=1,d=00')).resolves.toBe(false);
  });

  it('reads an unset APP_ENV as prod: https is enforced and no dev- prefix is applied', () => {
    const { APP_ENV: _drop, ...noEnv } = env;
    expect(() => new RetellConfig({ ...noEnv, API_PUBLIC_URL: 'http://api.example.test' })).toThrow(/https/);
    expect(new RetellConfig(noEnv).objectName('x')).toBe('x');
    expect(new RetellConfig({ ...env, APP_ENV: 'stagng' }).isProd).toBe(true);
  });

  it('treats a blank timeout or retry count as unset rather than as zero', () => {
    const blank = new RetellConfig({ ...env, RETELL_TIMEOUT_MS: '', RETELL_MAX_RETRIES: '  ' });
    expect(blank.timeoutMs).toBe(20_000);
    expect(blank.maxRetries).toBe(3);
    expect(new RetellConfig({ ...env, RETELL_MAX_RETRIES: '0' }).maxRetries).toBe(0);
    expect(() => new RetellConfig({ ...env, RETELL_TIMEOUT_MS: '0' })).toThrow(/RETELL_TIMEOUT_MS/);
    expect(() => new RetellConfig({ ...env, RETELL_TIMEOUT_MS: 'soon' })).toThrow(/RETELL_TIMEOUT_MS/);
  });
});

describe('webhook signature (§14.2)', () => {
  const body = '{"event":"call_ended","call":{"call_id":"call_1","metadata":{"b":1,"a":2}}}';

  it('accepts a signature computed over the exact raw body', async () => {
    const gw = gateway();
    const signature = await gw.signWebhookBody(body);
    expect(signature).toMatch(/^v=\d+,d=[0-9a-f]{64}$/);
    await expect(gw.verifyWebhookSignature(Buffer.from(body), signature)).resolves.toBe(true);
  });

  it('rejects a re-serialised body — key order and whitespace are part of the HMAC', async () => {
    const gw = gateway();
    const signature = await gw.signWebhookBody(body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    await expect(gw.verifyWebhookSignature(reserialised, signature)).resolves.toBe(false);
  });

  it('rejects a tampered body, a different key, and a missing header', async () => {
    const gw = gateway();
    const signature = await gw.signWebhookBody(body);
    await expect(gw.verifyWebhookSignature(body.replace('call_1', 'call_2'), signature)).resolves.toBe(false);
    await expect(gateway({ RETELL_API_KEY: 'key_other' }).verifyWebhookSignature(body, signature)).resolves.toBe(false);
    await expect(gw.verifyWebhookSignature(body, undefined)).resolves.toBe(false);
    await expect(gw.verifyWebhookSignature(undefined, signature)).resolves.toBe(false);
  });

  it('rejects a replay older than five minutes', async () => {
    const gw = gateway();
    const signature = await gw.signWebhookBody(body);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000);
    try {
      await expect(gw.verifyWebhookSignature(body, signature)).resolves.toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('inbound answers (§13.9, ADR 0003 §1)', () => {
  it('declines with HTTP-200 reject:true and nothing else', () => {
    expect(RetellGateway.inboundDecline()).toEqual({ call_inbound: { reject: true } });
  });

  it('allows with the agent, variables, metadata and a clamped duration override', () => {
    const answer = RetellGateway.inboundAllow({
      agentId: 'agent_1',
      dynamicVariables: { business_name: 'Maple Dental' },
      metadata: { tenant_id: 'ws_1', number_id: 'num_1', tier: 'standard' },
      maxCallDurationMs: 12_345,
    });
    expect(answer).toEqual({
      call_inbound: {
        override_agent_id: 'agent_1',
        dynamic_variables: { business_name: 'Maple Dental' },
        metadata: { tenant_id: 'ws_1', number_id: 'num_1', tier: 'standard' },
        agent_override: { agent: { max_call_duration_ms: 60_000 } },
      },
    });
  });

  it('omits the version so the number keeps following latest_published', () => {
    const answer = RetellGateway.inboundAllow({ agentId: 'agent_1' });
    expect(answer.call_inbound).not.toHaveProperty('override_agent_version');
    expect(answer.call_inbound).not.toHaveProperty('agent_override');
  });

  it('clamps to Retell’s [60 s, 2 h] window', () => {
    expect(clampDuration(1)).toBe(60_000);
    expect(clampDuration(90_000.4)).toBe(90_000);
    expect(clampDuration(99_999_999)).toBe(7_200_000);
  });
});

describe('Retell projection', () => {
  it('binds a number to one agent with weight 1, pinned to latest_published', async () => {
    const gw = gateway();
    const create = vi.spyOn(gw.client.phoneNumber, 'create').mockResolvedValue({} as never);
    await gw.createPhoneNumber({ numberToken: 'num_0123456789', agentId: 'agent_1', country: 'CA', nickname: 'Maple' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        country_code: 'CA',
        nickname: 'dev-Maple',
        inbound_agents: [{ agent_id: 'agent_1', agent_version: 'latest_published', weight: 1 }],
        inbound_webhook_url: 'https://api.example.test/webhooks/retell/inbound/num_0123456789',
      }),
    );
  });

  it('re-pins latest_published on every re-point, so an edit never answers a live call', async () => {
    const gw = gateway();
    const update = vi.spyOn(gw.client.phoneNumber, 'update').mockResolvedValue({} as never);
    await gw.updatePhoneNumber('+16204459730', { agentId: 'agent_2' });
    expect(update).toHaveBeenCalledWith(
      '+16204459730',
      expect.objectContaining({
        inbound_agents: [{ agent_id: 'agent_2', agent_version: 'latest_published', weight: 1 }],
      }),
    );
  });

  it('always points agents at our webhook and subscribes to the metering events', async () => {
    const gw = gateway();
    const create = vi.spyOn(gw.client.agent, 'create').mockResolvedValue({} as never);
    await gw.createAgent({
      name: 'Maple Dental',
      llmId: 'llm_1',
      voiceId: '11labs-Adrian',
      language: ['en-US', 'fr-CA'],
      maxCallDurationMs: 600_000,
    });
    const body = create.mock.calls[0]![0];
    expect(body.webhook_url).toBe('https://api.example.test/webhooks/retell');
    expect(body.webhook_events).toEqual(expect.arrayContaining(['call_started', 'call_ended', 'call_analyzed']));
    expect(body.agent_name).toBe('dev-Maple Dental');
    expect(body.response_engine).toEqual({ type: 'retell-llm', llm_id: 'llm_1' });
  });

  it('a web call always names an explicit version — that is the only door to a draft', async () => {
    const gw = gateway();
    const create = vi.spyOn(gw.client.call, 'createWebCall').mockResolvedValue({} as never);
    await gw.createWebCall({ agentId: 'agent_1', agentVersion: 3, metadata: { test: true } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'agent_1', agent_version: 3 }));
  });
});

describe('tier → stack (SA6)', () => {
  const tiers = {
    standard: { model: 'gpt-5-mini', default_voice_id: '11labs-Adrian', max_call_duration_ms: 1_800_000 },
    premium: { model: 'gpt-5', default_voice_id: '11labs-Adrian', max_call_duration_ms: 3_600_000 },
  };

  it('reads the mapping from configuration, never from code', () => {
    expect(stackFor(tiers, 'premium').model).toBe('gpt-5');
    expect(stackFor(tiers, 'standard').max_call_duration_ms).toBe(1_800_000);
  });

  it('rejects a config that would send Retell an out-of-range duration', () => {
    expect(() => stackFor({ ...tiers, standard: { ...tiers.standard, max_call_duration_ms: 1_000 } }, 'standard')).toThrow();
  });
});
