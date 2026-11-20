import { describe, expect, it } from 'vitest';
import en from '../i18n/messages/en.json';
import fr from '../i18n/messages/fr-CA.json';
import ar from '../i18n/messages/ar.json';
import { pricingFigures } from './pricing';

const pricing = (premium: number, trial: number, standard = 1) => ({ rates: { standard_per_min: standard, premium_per_min: premium }, wallet_policy: { trial_credits: trial } });

describe('pricingFigures (rates and trial size come from the published pricing)', () => {
  it('reads the figures a publish set', () => {
    expect(pricingFigures(pricing(1.5, 20))).toEqual({ standardRate: 1, premiumRate: 1.5, trialCredits: 20 });
    expect(pricingFigures(pricing(2, 25))).toEqual({ standardRate: 1, premiumRate: 2, trialCredits: 25 });
  });

  it('has no figure before the pricing has loaded, and none for a trial that grants nothing', () => {
    expect(pricingFigures(undefined)).toEqual({ standardRate: null, premiumRate: null, trialCredits: null });
    expect(pricingFigures(null).premiumRate).toBeNull();
    expect(pricingFigures(pricing(1.5, 0)).trialCredits).toBeNull();
    expect(pricingFigures(pricing(Number.NaN, 20)).premiumRate).toBeNull();
  });
});

describe('no catalogue types a rate or a trial size in (18 Nov QA)', () => {
  const lines = (m: typeof en) => [m.common.premiumRate, m.common.standardRate, m.auth.signup.subtitle, m.auth.setup.trialNote, m.wizard.w1.premiumHint, m.wizard.w3.subtitle, m.wizard.w3.premiumCost];

  it.each([
    ['en', en],
    ['fr-CA', fr as typeof en],
    ['ar', ar as typeof en],
  ])('%s', (_locale, messages) => {
    for (const line of lines(messages)) expect(line).not.toMatch(/\d/);
  });
});
