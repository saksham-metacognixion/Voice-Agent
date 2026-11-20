import { describe, expect, it } from 'vitest';
import { transferCallTools } from './retell.gateway';

/*
 * BUG-005: the model reads a tool's description, and "Transfer the caller to +1…" was read
 * aloud. The destination keeps the number — that is what the platform dials — and the
 * description never does.
 */
describe('transferCallTools', () => {
  const tools = transferCallTools([
    { number: '+14165550142', conditions: ['Party of more than 8', 'Asks for the manager'] },
    { number: '+14165550199', conditions: [] },
  ]);

  it('keeps the number as the destination the platform dials', () => {
    expect(tools.map((t) => t.transfer_destination)).toEqual([
      { type: 'predefined', number: '+14165550142' },
      { type: 'predefined', number: '+14165550199' },
    ]);
    expect(tools.map((t) => t.name)).toEqual(['transfer_1', 'transfer_2']);
  });

  it('never puts a digit of it in the description the model reads', () => {
    for (const tool of tools) {
      expect(tool.description).not.toMatch(/\d{3}/);
      expect(tool.description).toMatch(/Never say the number/);
    }
  });

  it('tells the model when to use each one, how to offer it, and what to say when it fails', () => {
    expect(tools[0]!.description).toContain('Use when: Party of more than 8; Asks for the manager.');
    expect(tools[0]!.description).toContain('Would you like me to transfer you to our staff?');
    expect(tools[0]!.description).toMatch(/does not go through.*offer to take a message/);
    expect(tools[1]!.description).toContain('Use when: the caller asks for a person.');
  });
});
