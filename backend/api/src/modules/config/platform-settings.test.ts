import { describe, expect, it } from 'vitest';
import { resolveSettings } from './platform-settings';

describe('resolveSettings (admin §9 platform settings)', () => {
  it('falls back to the defaults on a box with no rows and no env vars, as before', () => {
    expect(resolveSettings(new Map(), {})).toEqual({
      settings: { concurrency_platform_limit: null, concurrency_alert_pct: 80, reconcile_drift_threshold_pct: 5 },
      source: { concurrency_platform_limit: 'default', concurrency_alert_pct: 'default', reconcile_drift_threshold_pct: 'default' },
    });
  });

  it('reads the env vars the schedules used before', () => {
    const r = resolveSettings(new Map(), { CONCURRENCY_PLATFORM_LIMIT: '20', CONCURRENCY_ALERT_PCT: '90', RECONCILE_DRIFT_THRESHOLD_PCT: '2.5' });
    expect(r.settings).toEqual({ concurrency_platform_limit: 20, concurrency_alert_pct: 90, reconcile_drift_threshold_pct: 2.5 });
    expect(new Set(Object.values(r.source))).toEqual(new Set(['env']));
  });

  it('lets a console row win over its env var, including an explicit null ("not monitored")', () => {
    const r = resolveSettings(new Map<string, unknown>([['concurrency_platform_limit', null], ['concurrency_alert_pct', 70]]), { CONCURRENCY_PLATFORM_LIMIT: '20', CONCURRENCY_ALERT_PCT: '90' });
    expect(r.settings.concurrency_platform_limit).toBeNull();
    expect(r.settings.concurrency_alert_pct).toBe(70);
    expect(r.source).toEqual({ concurrency_platform_limit: 'console', concurrency_alert_pct: 'console', reconcile_drift_threshold_pct: 'default' });
  });
});
