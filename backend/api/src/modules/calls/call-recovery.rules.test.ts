import { describe, expect, it } from 'vitest';
import {
  RECOVER_ANALYSIS_MAX_CHECKS,
  RECOVER_ANALYSIS_WINDOW_MS,
  RECOVER_WINDOW_MS,
  type UnsettledCallRow,
  unsettledCallKind,
} from './call-recovery.rules';

/* ADR 0011 §7: which calls rows still wait on a lifecycle webhook the platform may never send. */

const NOW = Date.parse('2026-11-04T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms);
const MIN = 60_000;

function row(over: Partial<UnsettledCallRow> = {}): UnsettledCallRow {
  return { status: 'in_progress', endedAt: null, analysisJson: null, createdAt: ago(10 * MIN), recoveryChecks: 0, ...over };
}

describe('unsettledCallKind', () => {
  it.each(['registered', 'in_progress'])('a %s row with no end is unfinished', (status) => {
    expect(unsettledCallKind(row({ status }), NOW)).toBe('unfinished');
  });

  it('a live row that somehow has an end time is not asked about', () => {
    expect(unsettledCallKind(row({ endedAt: ago(MIN) }), NOW)).toBeNull();
  });

  it('an ended row without analysis is unanalysed, within the 6 h analysis window', () => {
    expect(unsettledCallKind(row({ status: 'ended', endedAt: ago(5 * MIN) }), NOW)).toBe('unanalysed');
    expect(unsettledCallKind(row({ status: 'ended', endedAt: ago(RECOVER_ANALYSIS_WINDOW_MS), createdAt: ago(RECOVER_ANALYSIS_WINDOW_MS + MIN) }), NOW)).toBe('unanalysed');
    expect(unsettledCallKind(row({ status: 'ended', endedAt: ago(RECOVER_ANALYSIS_WINDOW_MS + 1), createdAt: ago(RECOVER_ANALYSIS_WINDOW_MS + MIN) }), NOW)).toBeNull();
  });

  it('an ended row without endedAt measures the window from createdAt', () => {
    expect(unsettledCallKind(row({ status: 'ended', endedAt: null, createdAt: ago(MIN) }), NOW)).toBe('unanalysed');
    expect(unsettledCallKind(row({ status: 'ended', endedAt: null, createdAt: ago(RECOVER_ANALYSIS_WINDOW_MS + 1) }), NOW)).toBeNull();
  });

  it('an ended row with analysis is settled', () => {
    expect(unsettledCallKind(row({ status: 'ended', endedAt: ago(MIN), analysisJson: { call_summary: 'x' } }), NOW)).toBeNull();
  });

  it('stops asking about a missing analysis after the third check', () => {
    const ended = { status: 'ended', endedAt: ago(MIN) };
    expect(unsettledCallKind(row({ ...ended, recoveryChecks: RECOVER_ANALYSIS_MAX_CHECKS - 1 }), NOW)).toBe('unanalysed');
    expect(unsettledCallKind(row({ ...ended, recoveryChecks: RECOVER_ANALYSIS_MAX_CHECKS }), NOW)).toBeNull();
  });

  it('the check count does not cap an unfinished row', () => {
    expect(unsettledCallKind(row({ recoveryChecks: 50 }), NOW)).toBe('unfinished');
  });

  it('nothing older than the 24 h window, whatever its state', () => {
    expect(unsettledCallKind(row({ createdAt: ago(RECOVER_WINDOW_MS) }), NOW)).toBe('unfinished');
    expect(unsettledCallKind(row({ createdAt: ago(RECOVER_WINDOW_MS + 1) }), NOW)).toBeNull();
  });

  it.each(['missed', 'failed', 'declined', 'unknown'])('a %s row is never asked about', (status) => {
    expect(unsettledCallKind(row({ status }), NOW)).toBeNull();
  });
});
