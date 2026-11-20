import { describe, expect, it } from 'vitest';
import { OpsAlertService, formatAlert, redactAlert } from './ops-alert.service';

describe('redactAlert', () => {
  it('drops the value of any secret-looking field name', () => {
    const safe = redactAlert({
      kind: 'x',
      severity: 'warning',
      title: 't',
      fields: { sip_password: 'hunter2', api_key: 'key_abc', Authorization: 'Bearer x', access_token: 'tok', workspace_id: 'ws-1', attempts: 3 },
    });
    expect(safe.fields).toEqual({ sip_password: '[redacted]', api_key: '[redacted]', Authorization: '[redacted]', access_token: '[redacted]', workspace_id: 'ws-1', attempts: 3 });
  });

  it('drops values that look like credentials under an innocent name', () => {
    const safe = redactAlert({
      kind: 'x',
      severity: 'warning',
      title: 't',
      fields: { note: 'sk_test_51Habcdefghijklmnop', other: 'key_0123456789abcdef0123', jwt: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.sig', aws: 'AKIAABCDEFGHIJKLMNOP', ok: 'plain text' },
    });
    expect(safe.fields.note).toBe('[redacted]');
    expect(safe.fields.other).toBe('[redacted]');
    expect(safe.fields.jwt).toBe('[redacted]');
    expect(safe.fields.aws).toBe('[redacted]');
    expect(safe.fields.ok).toBe('plain text');
  });

  it('truncates long values and drops undefined ones', () => {
    const safe = redactAlert({ kind: 'x', severity: 'warning', title: 't', fields: { long: 'a'.repeat(1000), missing: undefined, nothing: null } });
    expect((safe.fields.long as string).length).toBe(500);
    expect('missing' in safe.fields).toBe(false);
    expect(safe.fields.nothing).toBeNull();
  });
});

describe('OpsAlertService', () => {
  it('delivers the redacted text to every sink and never throws when one fails', async () => {
    const delivered: string[] = [];
    const service = new OpsAlertService({ name: 'ok', deliver: async (_a, text) => void delivered.push(text) });
    service.addSink({ name: 'broken', deliver: async () => { throw new Error('boom'); } });
    await service.send({ kind: 'activation_failed', severity: 'critical', title: 'Failed', fields: { workspace_id: 'ws', sip_password: 'nope' } });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('[CRITICAL] activation_failed: Failed');
    expect(delivered[0]).toContain('workspace_id: ws');
    expect(delivered[0]).not.toContain('nope');
    expect(service.recent).toHaveLength(1);
  });

  it('gives up on a sink that hangs past the budget', async () => {
    const service = new OpsAlertService({ name: 'slow', deliver: () => new Promise(() => undefined) });
    const started = Date.now();
    await service.send({ kind: 'x', severity: 'warning', title: 't', fields: {} });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('formats one line per field plus a timestamp', () => {
    const text = formatAlert({ kind: 'k', severity: 'warning', title: 'T', fields: { a: 1, b: null }, at: new Date('2026-09-21T10:00:00Z') });
    expect(text.split('\n')).toEqual(['[WARNING] k: T', '  a: 1', '  b: null', '  at: 2026-09-21T10:00:00.000Z']);
  });
});
