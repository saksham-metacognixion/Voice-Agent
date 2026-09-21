import { describe, expect, it } from 'vitest';
import { toJobResponse } from './job-records.service';

/*
 * The GET /jobs/:id whitelist, against a row that carries everything the worker ever
 * writes. If a field reaches the wire it has to be named here, on purpose.
 */
const hostile = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'generate-agent',
  status: 'failed',
  stepsJson: {
    agent_id: '22222222-2222-4222-8222-222222222222',
    mode: 'generate',
    base_version: 1,
    version_id: 2,
    requested_by: '33333333-3333-4333-8333-333333333333',
    requested_at: '2026-09-17T10:00:00.000Z',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    provider_latency_ms: 812,
    provider_attempts: 2,
    usage: { input_tokens: 1200, output_tokens: 900 },
    queue_latency_ms: 12,
    total_ms: 1400,
    lint_findings: 1,
    retell_sync: 'failed',
    retell_error: 'RetellAPIError 500: llm_abcdef could not be created',
    retell_agent_version: 3,
    error_kind: 'not_configured',
    attempts_left: 0,
    customer_reason: 'Agent generation is unavailable right now. We have been notified.',
    changes: 0,
    refused: true,
    explanation: "I can't make the agent claim to be human.",
  },
  createdAt: new Date('2026-09-17T10:00:00.000Z'),
  updatedAt: new Date('2026-09-17T10:00:02.000Z'),
};

describe('toJobResponse', () => {
  it('carries exactly the whitelisted progress fields', () => {
    const out = toJobResponse(hostile);
    expect(out.progress).toEqual({
      agent_id: '22222222-2222-4222-8222-222222222222',
      mode: 'generate',
      base_version: 1,
      version_no: 2,
      changes: 0,
      refused: true,
      explanation: "I can't make the agent claim to be human.",
      lint_findings: 1,
    });
    expect(out).not.toHaveProperty('steps');
  });

  it('names no provider, model, platform or configuration detail anywhere', () => {
    const text = JSON.stringify(toJobResponse(hostile)).toLowerCase();
    for (const word of [
      'anthropic',
      'claude',
      'retell',
      'llm_',
      'provider',
      'model',
      'api_key',
      'not_configured',
      'usage',
      'requested_by',
    ]) {
      expect(text, word).not.toContain(word);
    }
  });

  it('shows the customer reason only when the job failed, and a generic line when none was written', () => {
    expect(toJobResponse(hostile).error).toBe(
      'Agent generation is unavailable right now. We have been notified.',
    );
    expect(toJobResponse({ ...hostile, status: 'succeeded' }).error).toBeNull();
    expect(toJobResponse({ ...hostile, status: 'running' }).error).toBeNull();
    const { customer_reason: _dropped, ...withoutReason } = hostile.stepsJson;
    expect(toJobResponse({ ...hostile, stepsJson: withoutReason }).error).toMatch(/try again/i);
  });

  it('tolerates a row with no steps at all', () => {
    const out = toJobResponse({ ...hostile, status: 'queued', stepsJson: null });
    expect(out.progress).toEqual({
      agent_id: null,
      mode: null,
      base_version: null,
      version_no: null,
      changes: null,
      refused: null,
      explanation: null,
      lint_findings: null,
    });
    expect(out.error).toBeNull();
  });

  it('ignores values of the wrong shape rather than passing them through', () => {
    const out = toJobResponse({
      ...hostile,
      stepsJson: {
        agent_id: 'agent_0123456789abcdef01234567',
        version_id: '2',
        mode: 'anthropic',
        explanation: 42,
      },
    });
    expect(out.progress).toMatchObject({
      agent_id: null,
      version_no: null,
      mode: null,
      explanation: null,
    });
  });
});
