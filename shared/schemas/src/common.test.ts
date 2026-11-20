import { describe, expect, it } from 'vitest';
import { paginationQuery } from './common.js';
import { ERROR_STATUS, ErrorCode } from './errors.js';
import { reasonCodeWithNote, roleAtLeast } from './enums.js';

describe('paginationQuery', () => {
  it('defaults the page size when the client sends nothing', () => {
    expect(paginationQuery.parse({})).toEqual({ limit: 25 });
  });

  it('coerces the limit out of a query string', () => {
    expect(paginationQuery.parse({ limit: '50' }).limit).toBe(50);
  });

  it('caps the page size so one request cannot pull a whole workspace', () => {
    expect(paginationQuery.safeParse({ limit: 500 }).success).toBe(false);
    expect(paginationQuery.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe('ERROR_STATUS', () => {
  it('gives every code exactly one status', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_STATUS[code], `no status for ${code}`).toBeGreaterThanOrEqual(400);
    }
  });

  it('keeps the three statuses the spec names in §16', () => {
    expect(ERROR_STATUS.NO_CREDITS).toBe(402);
    expect(ERROR_STATUS.EMAIL_UNVERIFIED).toBe(403);
    expect(ERROR_STATUS.TEST_RATE_LIMIT).toBe(429);
  });
});

describe('roleAtLeast', () => {
  it('lets an owner do anything an admin can', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
  });

  it('does not promote an editor or a viewer', () => {
    expect(roleAtLeast('editor', 'admin')).toBe(false);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
  });
});

describe('reasonCodeWithNote', () => {
  it('accepts a named reason on its own', () => {
    expect(reasonCodeWithNote.safeParse({ reason_code: 'goodwill' }).success).toBe(true);
  });

  it('demands a note when the reason is "other"', () => {
    expect(reasonCodeWithNote.safeParse({ reason_code: 'other' }).success).toBe(false);
    expect(reasonCodeWithNote.safeParse({ reason_code: 'other', note: 'ticket 812' }).success).toBe(
      true,
    );
  });
});
