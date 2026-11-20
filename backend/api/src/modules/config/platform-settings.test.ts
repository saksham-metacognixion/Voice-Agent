import { describe, expect, it } from 'vitest';
import { FX_SETTING_DEFAULTS } from './fx-settings';
import { resolveSettings } from './platform-settings';

const FX_DEFAULT_SOURCES = Object.fromEntries(Object.keys(FX_SETTING_DEFAULTS).map((key) => [key, 'default']));

describe('resolveSettings (admin §9 platform settings)', () => {
  it('falls back to the defaults on a box with no rows and no env vars, as before', () => {
    expect(resolveSettings(new Map(), {})).toEqual({
      settings: { concurrency_platform_limit: null, concurrency_alert_pct: 80, reconcile_drift_threshold_pct: 5, ...FX_SETTING_DEFAULTS },
      source: { concurrency_platform_limit: 'default', concurrency_alert_pct: 'default', reconcile_drift_threshold_pct: 'default', ...FX_DEFAULT_SOURCES },
    });
  });

  it('reads the env vars the schedules used before', () => {
    const r = resolveSettings(new Map(), { CONCURRENCY_PLATFORM_LIMIT: '20', CONCURRENCY_ALERT_PCT: '90', RECONCILE_DRIFT_THRESHOLD_PCT: '2.5' });
    expect(r.settings).toEqual({ concurrency_platform_limit: 20, concurrency_alert_pct: 90, reconcile_drift_threshold_pct: 2.5, ...FX_SETTING_DEFAULTS });
    expect([r.source.concurrency_platform_limit, r.source.concurrency_alert_pct, r.source.reconcile_drift_threshold_pct]).toEqual(['env', 'env', 'env']);
  });

  it('lets a console row win over its env var, including an explicit null ("not monitored")', () => {
    const r = resolveSettings(new Map<string, unknown>([['concurrency_platform_limit', null], ['concurrency_alert_pct', 70]]), { CONCURRENCY_PLATFORM_LIMIT: '20', CONCURRENCY_ALERT_PCT: '90' });
    expect(r.settings.concurrency_platform_limit).toBeNull();
    expect(r.settings.concurrency_alert_pct).toBe(70);
    expect(r.source).toEqual({ concurrency_platform_limit: 'console', concurrency_alert_pct: 'console', reconcile_drift_threshold_pct: 'default', ...FX_DEFAULT_SOURCES });
  });

  it('ADR 0049: the exchange-rate and rounding settings resolve console row → env var → default, key by key', () => {
    const r = resolveSettings(
      new Map<string, unknown>([['cad_rounding_step_cents', 500], ['fx_refresh_interval_hours', 12]]),
      { FX_REFRESH_INTERVAL_HOURS: '6', FX_STALE_AFTER_DAYS: '3', CAD_ROUNDING_MODE: 'up' },
    );
    expect(r.settings).toMatchObject({
      cad_rounding_step_cents: 500, // console
      fx_refresh_interval_hours: 12, // console over env
      fx_stale_after_days: 3, // env
      cad_rounding_mode: 'up', // env
      fx_source: 'bank_of_canada', // default
      fx_max_move_pct: 10, // default
    });
    expect(r.source).toMatchObject({ cad_rounding_step_cents: 'console', fx_refresh_interval_hours: 'console', fx_stale_after_days: 'env', cad_rounding_mode: 'env', fx_source: 'default', fx_max_move_pct: 'default' });
  });
});
