import { describe, expect, it } from 'vitest';
import { diffCounts, lineDiff } from './line-diff';

describe('lineDiff', () => {
  it('marks added, removed and unchanged lines', () => {
    const ops = lineDiff('a\nb\nc', 'a\nc\nd');
    expect(ops).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ]);
    expect(diffCounts(ops)).toEqual({ added: 1, removed: 1 });
  });
  it('is all-same for identical text and all-add for a new text', () => {
    expect(lineDiff('x\ny', 'x\ny').every((o) => o.kind === 'same')).toBe(true);
    expect(lineDiff('', 'x').filter((o) => o.kind === 'add')).toHaveLength(1);
  });
});
