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

// ADR 0039: the two W2 fields added on 5 Nov ride the same autosave.
describe('briefDiff + storableBrief — services free text and never-do presets (ADR 0039)', () => {
  const WITH = briefSchema.parse({ ...SAVED, services_notes: 'Cleanings take 45 minutes.', never_do_presets: ['no_prices', 'no_time_promises'] });

  it('sends the services free text as typed, and null once it is emptied', () => {
    expect(briefDiff(SAVED, storableBrief({ ...SAVED, services_notes: 'Same-day emergencies.' })!)).toEqual({ services_notes: 'Same-day emergencies.' });
    const patch = briefDiff(WITH, storableBrief({ ...WITH, services_notes: undefined })!);
    expect(patch).toEqual({ services_notes: null });
    expect(briefPatch.safeParse(patch).success).toBe(true);
  });

  it('sends a ticked or unticked preset as the whole list, [] when none is left', () => {
    expect(briefDiff(WITH, storableBrief({ ...WITH, never_do_presets: ['no_prices', 'no_time_promises', 'no_medical_advice'] })!)).toEqual({
      never_do_presets: ['no_prices', 'no_time_promises', 'no_medical_advice'],
    });
    expect(briefDiff(WITH, storableBrief({ ...WITH, never_do_presets: [] })!)).toEqual({ never_do_presets: [] });
  });

  it('holds back an unknown preset rather than saving it', () => {
    const next = storableBrief({ ...WITH, never_do_presets: ['no_prices', 'no_swearing'] })!;
    expect(next).not.toHaveProperty('never_do_presets');
    expect(briefDiff(WITH, next)).toEqual({});
  });
});

