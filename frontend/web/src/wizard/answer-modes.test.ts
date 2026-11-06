import { describe, expect, it } from 'vitest';
import { answerModeOptions, initialAnswerMode } from './answer-modes';

describe('answerModeOptions', () => {
  it('offers the spec’s three modes in order', () => {
    expect(answerModeOptions(null)).toEqual(['always', 'outside_hours', 'unanswered']);
    expect(answerModeOptions('unanswered')).toEqual(['always', 'outside_hours', 'unanswered']);
  });

  it('keeps a saved D4 mode on the list so reopening W6 changes nothing silently', () => {
    expect(answerModeOptions('business')).toEqual(['always', 'outside_hours', 'unanswered', 'business']);
    expect(answerModeOptions('custom')).toEqual(['always', 'outside_hours', 'unanswered', 'custom']);
  });

  it('starts on the saved mode, else Always', () => {
    expect(initialAnswerMode(undefined)).toBe('always');
    expect(initialAnswerMode('outside_hours')).toBe('outside_hours');
  });
});
