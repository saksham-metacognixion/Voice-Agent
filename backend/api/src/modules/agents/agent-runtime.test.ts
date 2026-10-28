import { defaultAgentSettings } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { runtimeAddOns } from './agent-runtime';

// QA-079 / QA-081: what a version's add-ons become at the sync, plan gates applied.
describe('runtimeAddOns', () => {
  const privacy = { recordingNotice: true, recordingNoticeText: null };
  const on = { ...defaultAgentSettings(), denoise: true, pii_removal: true };

  it('sends the add-ons the version has and the plan includes', () => {
    expect(runtimeAddOns(on, { denoise: true, pii_removal: true }, privacy)).toMatchObject({ denoise: true, piiRemoval: true });
  });

  it('sends them off for a workspace whose plan lost the gate, whatever the version says', () => {
    expect(runtimeAddOns(on, { denoise: false }, privacy)).toMatchObject({ denoise: false, piiRemoval: false });
  });

  it('sends nothing the version did not turn on, gate or not', () => {
    expect(runtimeAddOns(defaultAgentSettings(), { denoise: true, pii_removal: true }, privacy)).toMatchObject({ denoise: false, piiRemoval: false });
  });

  it('carries the recording notice for a recording agent, in its language, and none otherwise', () => {
    const fr = { ...defaultAgentSettings(), primary_language: 'fr-CA' as const };
    expect(runtimeAddOns(fr, {}, privacy).recordingNotice).toBe('Veuillez noter que cet appel est enregistré.');
    expect(runtimeAddOns({ ...fr, recording_enabled: false }, {}, privacy).recordingNotice).toBeNull();
    expect(runtimeAddOns(fr, {}, { recordingNotice: false, recordingNoticeText: 'x' }).recordingNotice).toBeNull();
  });
});
