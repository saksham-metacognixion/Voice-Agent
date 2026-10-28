import { describe, expect, it } from 'vitest';
import { transferFailMessage, updateNumberRequest } from '@portal/schemas';
import { spokenTransferFailMessage } from './staff-transfer';
import { TRANSFER_FAIL_MESSAGE_VAR, cleanTransferFailMessage, transferFailVariables } from './transfer-fail-message';

/*
 * QA-083 (D4 Hand-off, spec p. 37): a number's "Read-out message if transfer fails"
 * reaches the call as one dynamic variable the fixed transfer rule reads.
 */
describe('transferFailVariables', () => {
  it('is always supplied: empty for none, the trimmed words otherwise', () => {
    expect(TRANSFER_FAIL_MESSAGE_VAR).toBe('transfer_fail_message');
    expect(transferFailVariables(null)).toEqual({ transfer_fail_message: '' });
    expect(transferFailVariables(undefined)).toEqual({ transfer_fail_message: '' });
    expect(transferFailVariables('   ')).toEqual({ transfer_fail_message: '' });
    expect(transferFailVariables('  Please call back after 2 pm.  ')).toEqual({ transfer_fail_message: 'Please call back after 2 pm.' });
  });

  it('cannot smuggle another variable in, and keeps the message on one line', () => {
    expect(cleanTransferFailMessage('Call {{transfer_number_1}} now')).toBe('Call transfer_number_1 now');
    expect(cleanTransferFailMessage('Line one.\n\nLine two.')).toBe('Line one. Line two.');
    expect(cleanTransferFailMessage('a\u0000b')).toBe('ab');
    // A single brace is ordinary text.
    expect(cleanTransferFailMessage('Option {A}')).toBe('Option {A}');
  });
});

describe('spokenTransferFailMessage', () => {
  it('redacts the number\'s own transfer targets and keeps any other number', () => {
    expect(spokenTransferFailMessage('Or try the manager on 416-555-0142.', ['+14165550142'])).toBe('Or try the manager on our staff.');
    expect(spokenTransferFailMessage('Call our front desk on 416-555-0100.', ['+14165550142'])).toBe('Call our front desk on 416-555-0100.');
    expect(spokenTransferFailMessage(null, ['+14165550142'])).toBeNull();
    expect(spokenTransferFailMessage('  ', [])).toBeNull();
  });
});

describe('transferFailMessage (PATCH /numbers/:id)', () => {
  it('trims, stores blank as null, caps at 500 and refuses a NUL byte', () => {
    expect(transferFailMessage.parse('  Sorry, nobody is free.  ')).toBe('Sorry, nobody is free.');
    expect(transferFailMessage.parse('   ')).toBeNull();
    expect(transferFailMessage.safeParse('x'.repeat(500)).success).toBe(true);
    expect(transferFailMessage.safeParse('x'.repeat(501)).success).toBe(false);
    expect(transferFailMessage.safeParse('bad\u0000byte').success).toBe(false);
  });

  it('is a PATCH field of its own, and null clears it', () => {
    expect(updateNumberRequest.parse({ transfer_fail_message: null })).toEqual({ transfer_fail_message: null });
    expect(updateNumberRequest.parse({ transfer_fail_message: 'Back soon.' })).toEqual({ transfer_fail_message: 'Back soon.' });
    expect(updateNumberRequest.safeParse({ transfer_fail_message: 42 }).success).toBe(false);
  });
});
