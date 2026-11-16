import { describe, expect, it } from 'vitest';
import { messageCaptured } from './message-captured';

describe('messageCaptured (D1 messages taken, ADR 0041)', () => {
  it('is true on message_taken or a callback number', () => {
    expect(messageCaptured({ custom_analysis_data: { message_taken: true } })).toBe(true);
    expect(messageCaptured({ custom_analysis_data: { message_taken: 'true' } })).toBe(true);
    expect(messageCaptured({ custom_analysis_data: { callback_number: '+1 416 555 0100' } })).toBe(true);
  });
  it('is false otherwise, and never throws on odd shapes', () => {
    expect(messageCaptured({ custom_analysis_data: { message_taken: false, callback_number: '' } })).toBe(false);
    expect(messageCaptured({ custom_analysis_data: { callback_number: '   ' } })).toBe(false);
    expect(messageCaptured({ call_summary: 'hours question' })).toBe(false);
    expect(messageCaptured({ custom_analysis_data: 'x' })).toBe(false);
    expect(messageCaptured(null)).toBe(false);
    expect(messageCaptured([])).toBe(false);
  });
});
