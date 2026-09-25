import { describe, expect, it } from 'vitest';
import { exampleTextFor, industriesOf, industryConflicts } from './template-fit';

const restaurant = { industry_tags: ['restaurant'], example_texts: { restaurant: 'We are a forty-seat bistro.' } };
const receptionist = { industry_tags: ['dental', 'plumbing', 'generic'], example_texts: { dental: 'A family dental practice.', plumbing: 'Plumbers.', generic: 'A service business.' } };
const appointment = { industry_tags: ['dental', 'salon'], example_texts: { dental: 'Dental.', salon: 'Salon.' } };

describe('industryConflicts', () => {
  it('flags an industry the template was not written for', () => {
    expect(industryConflicts(restaurant, 'dental')).toBe(true);
    expect(industryConflicts(appointment, 'restaurant')).toBe(true);
  });
  it('accepts a matching industry, case and spaces aside', () => {
    expect(industryConflicts(restaurant, 'restaurant')).toBe(false);
    expect(industryConflicts(restaurant, ' Restaurant ')).toBe(false);
  });
  it('never conflicts with no industry, no template, or a generic template', () => {
    expect(industryConflicts(restaurant, '')).toBe(false);
    expect(industryConflicts(restaurant, null)).toBe(false);
    expect(industryConflicts(null, 'dental')).toBe(false);
    expect(industryConflicts(receptionist, 'restaurant')).toBe(false);
  });
});

describe('industriesOf', () => {
  it('drops the generic tag', () => {
    expect(industriesOf(receptionist)).toEqual(['dental', 'plumbing']);
    expect(industriesOf(null)).toEqual([]);
  });
});

describe('exampleTextFor', () => {
  it('prefers the chosen industry, then the template’s first, then generic', () => {
    expect(exampleTextFor(receptionist, 'plumbing')).toBe('Plumbers.');
    expect(exampleTextFor(receptionist, 'auto')).toBe('A family dental practice.');
    expect(exampleTextFor(receptionist, null)).toBe('A family dental practice.');
    expect(exampleTextFor(restaurant, 'dental')).toBe('We are a forty-seat bistro.');
    expect(exampleTextFor({ industry_tags: [], example_texts: { generic: 'Anything.' } }, null)).toBe('Anything.');
    expect(exampleTextFor(null, 'dental')).toBeNull();
  });
});
