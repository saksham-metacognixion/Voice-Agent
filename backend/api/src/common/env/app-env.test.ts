import { describe, expect, it } from 'vitest';
import { isDevEnv, isProdEnv, resolveAppEnv } from './app-env';

describe('resolveAppEnv (fail-closed)', () => {
  it('returns each recognised value as-is and maps production to prod', () => {
    expect(resolveAppEnv({ APP_ENV: 'dev' })).toBe('dev');
    expect(resolveAppEnv({ APP_ENV: 'ci' })).toBe('ci');
    expect(resolveAppEnv({ APP_ENV: 'staging' })).toBe('staging');
    expect(resolveAppEnv({ APP_ENV: 'prod' })).toBe('prod');
    expect(resolveAppEnv({ APP_ENV: ' production ' })).toBe('prod');
  });

  it('reads unset, blank and unrecognised values as prod — never as dev', () => {
    expect(resolveAppEnv({})).toBe('prod');
    expect(resolveAppEnv({ APP_ENV: '' })).toBe('prod');
    expect(resolveAppEnv({ APP_ENV: '   ' })).toBe('prod');
    expect(resolveAppEnv({ APP_ENV: 'development' })).toBe('prod');
    expect(resolveAppEnv({ APP_ENV: 'DEV' })).toBe('prod');
  });

  it('isDevEnv is true only for an explicit dev', () => {
    expect(isDevEnv({ APP_ENV: 'dev' })).toBe(true);
    expect(isDevEnv({})).toBe(false);
    expect(isDevEnv({ APP_ENV: 'staging' })).toBe(false);
    expect(isDevEnv({ APP_ENV: 'ci' })).toBe(false);
  });

  it('isProdEnv covers prod and everything it cannot place', () => {
    expect(isProdEnv({ APP_ENV: 'prod' })).toBe(true);
    expect(isProdEnv({})).toBe(true);
    expect(isProdEnv({ APP_ENV: 'nonsense' })).toBe(true);
    expect(isProdEnv({ APP_ENV: 'dev' })).toBe(false);
    expect(isProdEnv({ APP_ENV: 'staging' })).toBe(false);
  });
});
