import { describe, expect, it } from 'vitest';
import { mergeTranscript } from './transcript';

describe('mergeTranscript', () => {
  it('takes a full transcript as it is, growing last line included', () => {
    const a = mergeTranscript([], [{ role: 'agent', content: 'Hi, thanks for' }]);
    const b = mergeTranscript(a, [{ role: 'agent', content: 'Hi, thanks for calling.' }]);
    expect(b).toEqual([{ role: 'agent', content: 'Hi, thanks for calling.' }]);
  });

  it('aligns a trailing window on its first line instead of dropping the start of the call', () => {
    const prev = [
      { role: 'agent' as const, content: 'Hi, thanks for calling.' },
      { role: 'user' as const, content: 'I need a table' },
      { role: 'agent' as const, content: 'For how many?' },
    ];
    const merged = mergeTranscript(prev, [
      { role: 'user', content: 'I need a table for four' },
      { role: 'agent', content: 'For how many? Oh, four.' },
    ]);
    expect(merged).toEqual([
      { role: 'agent', content: 'Hi, thanks for calling.' },
      { role: 'user', content: 'I need a table for four' },
      { role: 'agent', content: 'For how many? Oh, four.' },
    ]);
  });

  it('drops tool calls and ignores an empty frame', () => {
    const prev = [{ role: 'agent' as const, content: 'Hello' }];
    expect(mergeTranscript(prev, [{ role: 'tool_call_invocation' }])).toBe(prev);
  });
});
