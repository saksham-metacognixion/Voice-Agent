import { describe, expect, it } from 'vitest';
import { capturedFields, parseAnalysis, sentimentOf, transcriptTurns } from './analysis';

describe('parseAnalysis', () => {
  it('reads the platform fields leniently and keeps the captured data', () => {
    const a = parseAnalysis({ call_summary: 'Booked.', user_sentiment: 'Positive', call_successful: 'yes', custom_analysis_data: { name: 'Ana', party_size: 4, empty: '' } });
    expect(a?.call_summary).toBe('Booked.');
    expect(a?.call_successful).toBeUndefined();
    expect(capturedFields(a)).toEqual([['name', 'Ana'], ['party_size', 4]]);
  });
  it('is null for anything that is not an object', () => {
    expect(parseAnalysis(null)).toBeNull();
    expect(parseAnalysis('x')).toBeNull();
  });
});

describe('sentimentOf', () => {
  it('maps the platform words and treats anything else as unknown', () => {
    expect(sentimentOf('Positive')).toBe('positive');
    expect(sentimentOf('negative')).toBe('negative');
    expect(sentimentOf('Neutral')).toBe('neutral');
    expect(sentimentOf('Mixed')).toBe('unknown');
    expect(sentimentOf(null)).toBeNull();
  });
});

describe('transcriptTurns', () => {
  it('prefers the structured transcript and drops non-speech entries', () => {
    const turns = transcriptTurns([{ role: 'agent', content: 'Hi' }, { role: 'tool_call_invocation', name: 'x' }, { role: 'user', content: ' Hello ' }], 'Agent: ignored');
    expect(turns).toEqual([{ role: 'agent', content: 'Hi' }, { role: 'user', content: 'Hello' }]);
  });
  it('falls back to the prefixed text, joining continuation lines', () => {
    const turns = transcriptTurns(null, 'Agent: Maple Dental,\nhow can I help?\nUser: A cleaning please.');
    expect(turns).toEqual([{ role: 'agent', content: 'Maple Dental, how can I help?' }, { role: 'user', content: 'A cleaning please.' }]);
  });
  it('is empty with nothing to read', () => {
    expect(transcriptTurns(null, null)).toEqual([]);
    expect(transcriptTurns([], '  ')).toEqual([]);
  });
});
