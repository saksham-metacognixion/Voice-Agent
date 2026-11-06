import { brief as briefSchema } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { prefillTransferTargets } from './transfer-prefill';

const brief = (rules: unknown[]) => briefSchema.parse({ handoff_rules: rules });

describe('prefillTransferTargets', () => {
  it('turns the brief’s transfer rules into labelled targets, one per number', () => {
    const b = brief([
      { condition: 'The caller says it is an emergency', action: 'transfer', transfer_number: '+14165550199' },
      { condition: 'Billing questions', action: 'transfer', transfer_number: '+14165550100' },
      { condition: 'Someone insists on the manager', action: 'transfer', transfer_number: '+14165550199' },
      { condition: 'Anything else urgent', action: 'take_message' },
    ]);
    expect(prefillTransferTargets(b)).toEqual([
      { label: 'The caller says it is an emergency', number: '+14165550199' },
      { label: 'Billing questions', number: '+14165550100' },
    ]);
  });

  it('keeps the label within what a target may hold', () => {
    const long = 'x'.repeat(80);
    expect(prefillTransferTargets(brief([{ condition: long, action: 'transfer', transfer_number: '+14165550199' }]))[0]?.label).toHaveLength(60);
  });

  it('is empty without a brief or without transfer rules', () => {
    expect(prefillTransferTargets(null)).toEqual([]);
    expect(prefillTransferTargets(brief([{ condition: 'Urgent', action: 'take_message' }]))).toEqual([]);
  });
});
