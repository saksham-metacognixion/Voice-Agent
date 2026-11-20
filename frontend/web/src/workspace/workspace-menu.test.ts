import { describe, expect, it } from 'vitest';
import { accountMenuWorkspace } from './workspace-menu';

const a = { id: 'ws_a', name: 'Maple Dental' };
const b = { id: 'ws_b', name: 'Night Plumbing' };

describe('accountMenuWorkspace (QA-013)', () => {
  it('offers the switch only with more than one membership', () => {
    expect(accountMenuWorkspace([a, b], 'ws_a')).toEqual({ kind: 'switch' });
    expect(accountMenuWorkspace([a, b], null)).toEqual({ kind: 'switch' });
  });

  it('names the only workspace instead of offering a switch to nowhere', () => {
    expect(accountMenuWorkspace([a], 'ws_a')).toEqual({ kind: 'current', membership: a });
  });

  it('says nothing before a workspace exists or is chosen', () => {
    expect(accountMenuWorkspace([], null)).toEqual({ kind: 'none' });
    expect(accountMenuWorkspace([a], null)).toEqual({ kind: 'none' });
  });
});
