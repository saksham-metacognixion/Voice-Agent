import { describe, expect, it } from 'vitest';
import { addNumberPath } from '../routes';
import { agentNeedsNumber } from './agent-reach';

describe('agentNeedsNumber', () => {
  it('is true for a live agent with no number', () => {
    expect(agentNeedsNumber({ status: 'live', numbers_attached: 0 })).toBe(true);
  });

  it('is false once a number is attached, even one still being set up', () => {
    expect(agentNeedsNumber({ status: 'live', numbers_attached: 1 })).toBe(false);
  });

  it('leaves draft and paused agents to their own status', () => {
    expect(agentNeedsNumber({ status: 'draft', numbers_attached: 0 })).toBe(false);
    expect(agentNeedsNumber({ status: 'paused', numbers_attached: 0 })).toBe(false);
  });
});

describe('addNumberPath', () => {
  it('opens Add number on the numbers page', () => {
    expect(addNumberPath()).toBe('/app/numbers/?add=1');
  });

  it('names the agent to pre-select', () => {
    expect(addNumberPath('a b')).toBe('/app/numbers/?add=1&agent=a+b');
  });
});
