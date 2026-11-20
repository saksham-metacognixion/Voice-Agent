import { describe, expect, it } from 'vitest';
import { brief as briefSchema } from '@portal/schemas';
import { STAFF_LABEL, briefTransferNumbers, numberTransferTargets, numberTransferVariables, redactTransferNumbers, transferRoutes } from './staff-transfer';

/*
 * BUG-005 (26 Oct): the agent read the staff transfer number aloud when it offered a
 * transfer and again when it retried. Whatever the stored script says, the number does
 * not reach what the model reads; the transfer tool still carries it to dial.
 */

const STAFF = '+14165550142';

describe('redactTransferNumbers', () => {
  it.each([
    ['+14165550142'],
    ['+1 416 555 0142'],
    ['+1 (416) 555-0142'],
    ['(416) 555-0142'],
    ['416-555-0142'],
    ['416.555.0142'],
    ['1-416-555-0142'],
    ['4165550142'],
  ])('replaces %s with the staff label', (written) => {
    const out = redactTransferNumbers(`If they ask for the manager, transfer them to ${written}.`, [STAFF]);
    expect(out).toBe(`If they ask for the manager, transfer them to ${STAFF_LABEL}.`);
    expect(out.replace(/\D/g, '')).toBe('');
  });

  it('replaces the platform variable that would be filled with the number', () => {
    expect(redactTransferNumbers('Transfer to {{transfer_number_1}} or {{ transfer_number_2 }}.', [STAFF])).toBe(
      `Transfer to ${STAFF_LABEL} or ${STAFF_LABEL}.`,
    );
  });

  it('handles a number with a trunk prefix outside North America', () => {
    expect(redactTransferNumbers('Call 020 7946 0018 or +44 20 7946 0018.', ['+442079460018'])).toBe(
      `Call ${STAFF_LABEL} or ${STAFF_LABEL}.`,
    );
  });

  it('leaves every other number alone: the business line, prices, hours, a longer number', () => {
    const text = 'Our main line is +1 416 555 0100. Pasta is $14. Open 9 to 5. Ref 94165550142.';
    expect(redactTransferNumbers(text, [STAFF])).toBe(text);
  });

  it('is idempotent and a no-op without transfer numbers', () => {
    const once = redactTransferNumbers(`Transfer to ${STAFF}.`, [STAFF]);
    expect(redactTransferNumbers(once, [STAFF])).toBe(once);
    expect(redactTransferNumbers(`Transfer to ${STAFF}.`, [])).toBe(`Transfer to ${STAFF}.`);
  });
});

describe('transferRoutes', () => {
  it('groups the conditions per number, in first-seen order, and ignores other actions', () => {
    const brief = briefSchema.parse({
      handoff_rules: [
        { condition: 'Party of more than 8', action: 'transfer', transfer_number: STAFF },
        { condition: 'After hours', action: 'take_message' },
        { condition: 'A complaint', action: 'transfer', transfer_number: '+14165550199' },
        { condition: 'Asks for the manager', action: 'transfer', transfer_number: STAFF },
      ],
    });
    expect(transferRoutes(brief)).toEqual([
      { number: STAFF, conditions: ['Party of more than 8', 'Asks for the manager'] },
      { number: '+14165550199', conditions: ['A complaint'] },
    ]);
  });
});

describe('a number’s transfer targets and the fail message (QA-083)', () => {
  const BRIEF_STAFF = '+14165550199';
  const briefJson = { handoff_rules: [{ condition: 'A complaint', action: 'transfer', transfer_number: BRIEF_STAFF }, { condition: 'Hours', action: 'take_message' }] };

  it('reads `{number}` entries and the plain strings an older row holds, and nothing else', () => {
    expect(numberTransferTargets([{ label: 'Manager', number: STAFF }, '+14165550111', 42, null, { label: 'x' }])).toEqual([STAFF, '+14165550111']);
    expect(numberTransferTargets(null)).toEqual([]);
  });

  it('reads the brief’s transfer numbers from stored JSON, deduplicated, tolerating junk', () => {
    expect(briefTransferNumbers({ handoff_rules: [...briefJson.handoff_rules, briefJson.handoff_rules[0], { action: 'transfer', transfer_number: '' }, 'junk'] })).toEqual([BRIEF_STAFF]);
    expect(briefTransferNumbers(null)).toEqual([]);
    expect(briefTransferNumbers({ handoff_rules: 'nope' })).toEqual([]);
  });

  it('carries the number’s targets as transfer_number_N and redacts the brief’s defaults out of the message too', () => {
    const variables = numberTransferVariables(
      { transferTargetsJson: ['+14165550111'], transferFailMessage: 'Sorry. Try 416-555-0199, 416 555 0111, or our desk at 416-555-0100.' },
      briefJson,
    );
    expect(variables).toEqual({
      transfer_number_1: '+14165550111',
      transfer_fail_message: `Sorry. Try ${STAFF_LABEL}, ${STAFF_LABEL}, or our desk at 416-555-0100.`,
    });
  });

  it('a number with no targets keeps the brief’s defaults out of the message (they are what it dials)', () => {
    expect(numberTransferVariables({ transferTargetsJson: [], transferFailMessage: `Call ${BRIEF_STAFF} directly.` }, briefJson)).toEqual({
      transfer_fail_message: `Call ${STAFF_LABEL} directly.`,
    });
    expect(numberTransferVariables({ transferTargetsJson: null, transferFailMessage: null }, null)).toEqual({ transfer_fail_message: '' });
  });
});
