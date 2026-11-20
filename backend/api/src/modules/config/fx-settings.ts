import { type CurrencyRounding, type PlatformSettings, currencyRounding, fxSource, roundingMode } from '@portal/schemas';

/*
 * The exchange-rate and rounding settings (ADR 0049), read the way every platform setting
 * is: a `platform_settings` row set from the console wins, then the environment variable,
 * then the default below. The defaults are the proposal put to the spec owner — the Bank
 * of Canada daily rate, refreshed once a day, a CAD price rounded to the nearest dollar —
 * and each is one console edit away from being something else. No rate has a default.
 */

export type FxSettings = Pick<
  PlatformSettings,
  'fx_source' | 'fx_refresh_interval_hours' | 'fx_stale_after_days' | 'fx_max_move_pct' | 'cad_rounding_step_cents' | 'cad_rounding_mode'
>;

export const FX_SETTING_DEFAULTS: FxSettings = {
  fx_source: 'bank_of_canada',
  fx_refresh_interval_hours: 24,
  fx_stale_after_days: 5,
  fx_max_move_pct: 10,
  cad_rounding_step_cents: 100,
  cad_rounding_mode: 'nearest',
};

function intFromEnv(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const value = Number(raw);
  return value >= min && value <= max ? value : fallback;
}

/** The environment's values, each falling back to its default when unset or out of range. */
export function fxSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): FxSettings {
  const source = fxSource.safeParse(env.FX_SOURCE);
  const mode = roundingMode.safeParse(env.CAD_ROUNDING_MODE);
  return {
    fx_source: source.success ? source.data : FX_SETTING_DEFAULTS.fx_source,
    fx_refresh_interval_hours: intFromEnv(env.FX_REFRESH_INTERVAL_HOURS, 1, 168, FX_SETTING_DEFAULTS.fx_refresh_interval_hours),
    fx_stale_after_days: intFromEnv(env.FX_STALE_AFTER_DAYS, 1, 30, FX_SETTING_DEFAULTS.fx_stale_after_days),
    fx_max_move_pct: intFromEnv(env.FX_MAX_MOVE_PCT, 1, 50, FX_SETTING_DEFAULTS.fx_max_move_pct),
    cad_rounding_step_cents: intFromEnv(env.CAD_ROUNDING_STEP_CENTS, 1, 10_000, FX_SETTING_DEFAULTS.cad_rounding_step_cents),
    cad_rounding_mode: mode.success ? mode.data : FX_SETTING_DEFAULTS.cad_rounding_mode,
  };
}

/** The rounding rule for a converted CAD price, from the resolved settings. */
export function cadRounding(settings: Pick<FxSettings, 'cad_rounding_step_cents' | 'cad_rounding_mode'>): CurrencyRounding {
  return currencyRounding.parse({ step_cents: settings.cad_rounding_step_cents, mode: settings.cad_rounding_mode });
}
