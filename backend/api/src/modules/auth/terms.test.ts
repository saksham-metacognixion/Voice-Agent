import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMS_VERSION } from '@portal/schemas';

/* ADR 0036 §6: workspace creation, invite accept and checkout refuse until the Terms in force are accepted. */

const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }));
vi.mock('@portal/db', () => ({ adminDb: db }));

import { assertTermsAccepted } from './terms';

beforeEach(() => {
  db.user.findUnique.mockReset();
});

describe('assertTermsAccepted', () => {
  it('passes a user who accepted the version in force, reading only tos_version', async () => {
    db.user.findUnique.mockResolvedValue({ tosVersion: TERMS_VERSION });
    await expect(assertTermsAccepted('u-1')).resolves.toBeUndefined();
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { id: 'u-1' }, select: { tosVersion: true } });
  });

  it.each([
    ['never accepted', { tosVersion: null }],
    ['accepted an older version', { tosVersion: '2000-01-01' }],
    ['has no users row', null],
  ])('refuses a user who %s with TERMS_NOT_ACCEPTED (403)', async (_label, row) => {
    db.user.findUnique.mockResolvedValue(row);
    await expect(assertTermsAccepted('u-1')).rejects.toMatchObject({ code: 'TERMS_NOT_ACCEPTED', status: 403 });
  });
});
