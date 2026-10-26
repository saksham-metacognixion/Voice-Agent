import { brief as briefSchema, briefPatch } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { briefDiff, storableBrief } from './brief-patch';

const SAVED = briefSchema.parse({
  about_business: 'A family dental clinic in Laval.',
  goal: 'Answer calls and take messages.',
  agent_name: 'Sophie',
  address: '12 Rue Principale',
  pricing: 'Cleaning $120.',
  anything_else: 'Parking at the back.',
  never_do: 'Never quote a wait time.',
});

/** What the form hands the autosave after the person emptied `field` (`setValueAs` → undefined). */
function cleared(...fields: string[]) {
  const v: Record<string, unknown> = { ...SAVED };
  for (const f of fields) v[f] = undefined;
  return v;
}

describe('briefDiff + storableBrief — clearing an optional field (QA-006)', () => {
  it.each(['agent_name', 'address', 'pricing', 'anything_else', 'never_do'])('sends %s as null once it is emptied', (field) => {
    const next = storableBrief(cleared(field))!;
    const patch = briefDiff(SAVED, next);
    expect(patch).toEqual({ [field]: null });
    // And null survives the trip: JSON keeps it, where it dropped undefined.
    expect(JSON.parse(JSON.stringify({ brief: patch })).brief).toEqual({ [field]: null });
    expect(briefPatch.safeParse(patch).success).toBe(true);
  });

  it('sends nothing for a field that was empty before and still is', () => {
    const before = briefSchema.parse({ goal: 'Answer calls and take messages.' });
    const next = storableBrief({ ...before, agent_name: undefined })!;
    expect(briefDiff(before, next)).toEqual({});
  });

  it('does not clear a field the schema refuses — a one-letter name is held back, not wiped', () => {
    const next = storableBrief({ ...SAVED, agent_name: 'S' })!;
    expect(next).not.toHaveProperty('agent_name');
    expect(briefDiff(SAVED, next)).toEqual({});
  });

  it('still sends a changed value as the value', () => {
    const next = storableBrief({ ...SAVED, agent_name: 'Camille' })!;
    expect(briefDiff(SAVED, next)).toEqual({ agent_name: 'Camille' });
  });

  it('does not send a defaulted array as a wipe when a row is incomplete', () => {
    const withFaq = briefSchema.parse({ ...SAVED, faqs: [{ question: 'Open Sunday?', answer: 'No.' }] });
    const next = storableBrief({ ...withFaq, faqs: [{ question: 'Open Sunday?', answer: 'No.' }, { question: '', answer: '' }] })!;
    expect(briefDiff(withFaq, next)).toEqual({});
  });
});
