import { describe, expect, it } from 'vitest';
import { defaultRecordingNotice, greetingWithNotice, recordingNotice } from './recording-notice';

// QA-081: the recording notice is said before the greeting, added at the sync, never stored.
describe('recordingNotice', () => {
  const base = { recording: true, enabled: true, text: null, language: 'en-US' as const };

  it('says ours, in the agent’s language, when the agent records and the workspace has it on', () => {
    expect(recordingNotice(base)).toBe('Just so you know, this call is recorded.');
    expect(recordingNotice({ ...base, language: 'fr-CA' })).toBe('Veuillez noter que cet appel est enregistré.');
    expect(recordingNotice({ ...base, language: 'ar-AE' })).toBe('للعلم، هذه المكالمة مسجّلة.');
  });

  it('says nothing for an agent that does not record, or a workspace that turned it off', () => {
    expect(recordingNotice({ ...base, recording: false })).toBeNull();
    expect(recordingNotice({ ...base, enabled: false })).toBeNull();
  });

  it('uses the business’s own line as written, and ours when that line is blank', () => {
    expect(recordingNotice({ ...base, language: 'fr-CA', text: '  Calls are recorded for training.  ' })).toBe('Calls are recorded for training.');
    expect(recordingNotice({ ...base, text: '   ' })).toBe('Just so you know, this call is recorded.');
  });
});

describe('defaultRecordingNotice', () => {
  it('prefers the full locale, then the base language, then English', () => {
    expect(defaultRecordingNotice('pt-BR')).toContain('ligação');
    expect(defaultRecordingNotice('pt-PT')).toContain('chamada');
    expect(defaultRecordingNotice('es-419')).toBe(defaultRecordingNotice('es-ES'));
    expect(defaultRecordingNotice('sw-KE')).toBe('Just so you know, this call is recorded.');
  });
});

describe('greetingWithNotice', () => {
  const notice = 'Just so you know, this call is recorded.';

  it('puts the notice before the greeting', () => {
    expect(greetingWithNotice('Thank you for calling Maple Dental.', notice)).toBe(
      'Just so you know, this call is recorded. Thank you for calling Maple Dental.',
    );
  });

  it('leaves a greeting alone with no notice, or one that already says it', () => {
    expect(greetingWithNotice('Hello.', null)).toBe('Hello.');
    const already = 'Hi! just so you know this call is recorded — how can I help?';
    expect(greetingWithNotice(already, notice)).toBe(already);
    // Idempotent, so a greeting that went through it once is not doubled.
    const once = greetingWithNotice('Hello.', notice)!;
    expect(greetingWithNotice(once, notice)).toBe(once);
  });

  it('adds nothing to a version without a greeting', () => {
    expect(greetingWithNotice(null, notice)).toBeNull();
  });
});
