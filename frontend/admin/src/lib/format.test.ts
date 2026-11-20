import { describe, expect, it } from 'vitest';
import { formatMinutes } from './format';

describe('formatMinutes', () => {
  it('shows minutes under an hour', () => {
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(1)).toBe('1 min');
    expect(formatMinutes(12.4)).toBe('12 min');
    expect(formatMinutes(0.2)).toBe('< 1 min');
  });

  it('shows hours and minutes from an hour', () => {
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(200)).toBe('3 h 20 min');
    expect(formatMinutes(1439)).toBe('23 h 59 min');
    expect(formatMinutes(59.6)).toBe('1 h');
  });

  it('shows days to one decimal from a day', () => {
    expect(formatMinutes(1440)).toBe('1 day');
    expect(formatMinutes(2160)).toBe('1.5 days');
    expect(formatMinutes(1439.7)).toBe('1 day');
    expect(formatMinutes(37_098)).toBe('25.8 days');
  });

  it('handles zero and missing values', () => {
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(-5)).toBe('0 min');
    expect(formatMinutes(null)).toBe('–');
    expect(formatMinutes(undefined)).toBe('–');
    expect(formatMinutes(Number.NaN)).toBe('–');
    expect(formatMinutes(Number.POSITIVE_INFINITY)).toBe('–');
  });
});
