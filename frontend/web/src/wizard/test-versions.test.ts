import { describe, expect, it } from 'vitest';
import { resolveTestVersion, testableVersions } from './test-versions';

const at = '2026-10-01T10:00:00.000Z';
const v = (version_no: number, over: Partial<{ is_draft: boolean; is_published: boolean; published_at: string | null; has_prompt: boolean }> = {}) => ({
  version_no,
  is_draft: false,
  is_published: false,
  published_at: null,
  has_prompt: true,
  ...over,
});

describe('testableVersions (QA-082)', () => {
  it('offers the draft and every version that was published, newest first', () => {
    const list = testableVersions([v(1, { published_at: at }), v(3, { published_at: at, is_published: true }), v(5, { is_draft: true }), v(2), v(4)]);
    expect(list).toEqual([
      { version_no: 5, kind: 'draft' },
      { version_no: 3, kind: 'live' },
      { version_no: 1, kind: 'published' },
    ]);
  });

  it('leaves out an older draft and a version without a script', () => {
    expect(testableVersions([v(2), v(3, { is_draft: true, has_prompt: false })])).toEqual([]);
  });

  it('names a draft that is also the live version live', () => {
    expect(testableVersions([v(2, { is_draft: true, is_published: true, published_at: at })])).toEqual([{ version_no: 2, kind: 'live' }]);
  });
});

describe('resolveTestVersion', () => {
  const options = testableVersions([v(4, { is_draft: true }), v(2, { published_at: at, is_published: true })]);

  it('keeps a pick that is still on offer', () => {
    expect(resolveTestVersion(options, 2, 4)).toBe(2);
  });

  it('falls back to the draft when the pick is gone or there is none', () => {
    expect(resolveTestVersion(options, 3, 4)).toBe(4);
    expect(resolveTestVersion(options, null, 4)).toBe(4);
  });

  it('uses the draft while the list loads, and the newest testable one when the draft is not testable', () => {
    expect(resolveTestVersion([], null, 4)).toBe(4);
    expect(resolveTestVersion(options, null, 7)).toBe(4);
    expect(resolveTestVersion([], null, null)).toBeNull();
  });
});
