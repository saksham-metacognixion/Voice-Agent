import type { PlatformSettingKey, PlatformSettings } from '@portal/schemas';
import { concurrencyAlertPct, platformConcurrencyLimit } from '../calls/concurrency-monitor';
import { driftThresholdPct } from '../calls/reconcile';

export type SettingSource = 'console' | 'env' | 'default';

export interface ResolvedSettings {
  settings: PlatformSettings;
  source: Record<PlatformSettingKey, SettingSource>;
}

const ENV_NAME: Record<PlatformSettingKey, string> = {
  concurrency_platform_limit: 'CONCURRENCY_PLATFORM_LIMIT',
  concurrency_alert_pct: 'CONCURRENCY_ALERT_PCT',
  reconcile_drift_threshold_pct: 'RECONCILE_DRIFT_THRESHOLD_PCT',
};

/**
 * Admin §9 platform settings, pure: a `platform_settings` row wins (even one that says
 * `null` — "not monitored", set on purpose), then the environment variable that used to be
 * the only way, then the compiled default. The env readers are the ones the schedules used
 * before, so a box with no rows behaves exactly as it did.
 */
export function resolveSettings(rows: ReadonlyMap<string, unknown>, env: NodeJS.ProcessEnv = process.env): ResolvedSettings {
  const source = {} as Record<PlatformSettingKey, SettingSource>;
  const pick = <K extends PlatformSettingKey>(key: K, fromEnv: PlatformSettings[K]): PlatformSettings[K] => {
    if (rows.has(key)) {
      source[key] = 'console';
      return rows.get(key) as PlatformSettings[K];
    }
    source[key] = env[ENV_NAME[key]] ? 'env' : 'default';
    return fromEnv;
  };
  return {
    settings: {
      concurrency_platform_limit: pick('concurrency_platform_limit', platformConcurrencyLimit(env)),
      concurrency_alert_pct: pick('concurrency_alert_pct', concurrencyAlertPct(env)),
      reconcile_drift_threshold_pct: pick('reconcile_drift_threshold_pct', driftThresholdPct(env)),
    },
    source,
  };
}
