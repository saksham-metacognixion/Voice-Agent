import { describe, expect, it } from 'vitest';
import { duplicateNameAt, isFieldName, rowToField, toRow } from './analysis-fields';

// QA-079: the D3 Brief analysis-fields editor turns rows into what PATCH /agents/:id/draft takes.
describe('rowToField', () => {
  it('builds a text field, trimmed', () => {
    expect(rowToField({ name: ' caller_name ', type: 'text', description: ' Who rang. ', choices: '' })).toEqual({
      name: 'caller_name',
      type: 'text',
      description: 'Who rang.',
    });
  });

  it('splits enum choices on Latin and Arabic commas and drops empty ones', () => {
    expect(rowToField({ name: 'urgency', type: 'enum', description: 'How urgent.', choices: 'low, medium،high, ' })).toEqual({
      name: 'urgency',
      type: 'enum',
      description: 'How urgent.',
      enum: ['low', 'medium', 'high'],
    });
  });

  it('is null until the row is valid: no name, a bad name, no description, an enum with no choices', () => {
    expect(rowToField({ name: '', type: 'text', description: 'x', choices: '' })).toBeNull();
    expect(rowToField({ name: 'Caller Name', type: 'text', description: 'x', choices: '' })).toBeNull();
    expect(rowToField({ name: 'reason', type: 'boolean', description: '  ', choices: '' })).toBeNull();
    expect(rowToField({ name: 'urgency', type: 'enum', description: 'How urgent.', choices: ' , ' })).toBeNull();
  });

  it('round-trips a stored field through a row', () => {
    const field = { name: 'urgency', type: 'enum' as const, description: 'How urgent.', enum: ['low', 'high'] };
    expect(rowToField(toRow(field, 1))).toEqual(field);
  });
});

describe('names', () => {
  it('accepts snake_case starting with a letter only', () => {
    expect(isFieldName('callback_number')).toBe(true);
    expect(isFieldName('2nd_number')).toBe(false);
    expect(isFieldName('callback-number')).toBe(false);
  });

  it('flags the second of two rows with the same name, not the first', () => {
    const rows = [{ name: 'reason' }, { name: 'urgency' }, { name: ' reason' }, { name: '' }, { name: '' }];
    expect(duplicateNameAt(rows, 0)).toBe(false);
    expect(duplicateNameAt(rows, 2)).toBe(true);
    expect(duplicateNameAt(rows, 4)).toBe(false);
  });
});
