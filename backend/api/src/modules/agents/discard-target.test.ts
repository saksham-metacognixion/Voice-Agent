import { describe, expect, it } from 'vitest';
import { discardTarget, toSummary } from './agents.service';

/*
 * D3 "Discard draft" (QA-078): the route and the button decide from the same two
 * pointers, and must agree with `has_unpublished_changes` — a Discard the portal offers
 * is one the route performs, and one it hides would be refused.
 */

describe('discardTarget', () => {
  it('points the draft back at the published version', () => {
    expect(discardTarget({ draftVersion: 4, publishedVersion: 2 })).toEqual({ ok: true, discarded: 4, restore: 2 });
  });

  it('also discards an older version restored as the draft', () => {
    expect(discardTarget({ draftVersion: 1, publishedVersion: 3 })).toEqual({ ok: true, discarded: 1, restore: 3 });
  });

  it('has nothing to go back to before the first publish', () => {
    expect(discardTarget({ draftVersion: 2, publishedVersion: null })).toEqual({ ok: false, code: 'AGENT_NOT_PUBLISHED' });
  });

  it('has nothing to discard when the draft is the live version', () => {
    expect(discardTarget({ draftVersion: 3, publishedVersion: 3 })).toEqual({ ok: false, code: 'NO_DRAFT_CHANGES' });
    expect(discardTarget({ draftVersion: null, publishedVersion: 3 })).toEqual({ ok: false, code: 'NO_DRAFT_CHANGES' });
  });

  it('agrees with has_unpublished_changes whenever the agent has been published', () => {
    const row = {
      id: 'a',
      name: 'Front desk',
      templateId: 'receptionist',
      industry: null,
      status: 'live',
      tier: 'standard',
      primaryLanguage: 'en-US',
      languages: [],
      voiceId: null,
      voiceSpeed: null,
      voiceTemperature: null,
      maxCallDurationS: 600,
      recordingEnabled: true,
      createdAt: new Date(0),
    };
    for (const draftVersion of [null, 1, 2, 3]) {
      const pointers = { draftVersion, publishedVersion: 2 };
      expect(discardTarget(pointers).ok).toBe(toSummary({ ...row, ...pointers }, 0).has_unpublished_changes);
    }
  });
});
