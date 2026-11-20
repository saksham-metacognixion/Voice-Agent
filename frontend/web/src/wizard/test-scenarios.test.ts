import { brief as briefSchema } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { canTransfer, needsPhoneTransfer } from './test-scenarios';

const withTransfer = briefSchema.parse({
  handoff_rules: [
    { condition: 'A complaint about a meal', action: 'transfer', transfer_number: '+14165550142' },
    { condition: 'After hours', action: 'take_message' },
  ],
});
const withoutTransfer = briefSchema.parse({ handoff_rules: [{ condition: 'After hours', action: 'take_message' }] });

describe('needsPhoneTransfer (BUG-006)', () => {
  it.each([
    ['Ask for the manager', 'Can I speak to the manager please?'],
    ['Get a person', 'I want to talk to a real person.'],
    ['Transfer', 'Could you transfer me?'],
    ['Put through', 'Can you put me through to the kitchen?'],
    ['Complaint', 'I have a complaint about a meal I had last night.'],
    ['En français', 'Je voudrais parler à quelqu’un.'],
  ])('flags "%s" when the agent can transfer', (title, say_this) => {
    expect(needsPhoneTransfer({ title, say_this }, withTransfer)).toBe(true);
  });

  it.each([
    ['Book a table', 'A table for four on Friday at seven, please.'],
    ['Vegetarian options', 'What vegetarian dishes do you have?'],
    ['Hours', 'Are you open on Sunday?'],
    ['Parking', 'Is there parking nearby?'],
  ])('leaves ordinary conversation alone: "%s"', (title, say_this) => {
    expect(needsPhoneTransfer({ title, say_this }, withTransfer)).toBe(false);
  });

  it('flags nothing for an agent with no transfer rule — it cannot transfer at all', () => {
    expect(canTransfer(withoutTransfer)).toBe(false);
    expect(needsPhoneTransfer({ title: 'Ask for the manager', say_this: 'Can I speak to the manager?' }, withoutTransfer)).toBe(false);
    expect(needsPhoneTransfer({ title: 'x', say_this: 'transfer me' }, null)).toBe(false);
  });
});
