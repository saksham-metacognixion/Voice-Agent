import { describe, expect, it } from 'vitest';
import { STAFF_INVITE_PREFIX as GUARD_PREFIX } from '../auth/auth.guard';
import {
  STAFF_INVITE_PREFIX,
  staffEmailDomain,
  staffInvitePlaceholder,
} from './admin-staff.service';

describe('staff invites (SA13, D13)', () => {
  it('spells the placeholder the way the auth guard binds it', () => {
    expect(STAFF_INVITE_PREFIX).toBe(GUARD_PREFIX);
    expect(staffInvitePlaceholder(' Ada@Example.com ')).toBe(`${GUARD_PREFIX}ada@example.com`);
  });

  it('reads the staff domain from one place, lower-cased and without an @', () => {
    expect(
      staffEmailDomain({ STAFF_ALLOWED_EMAIL_DOMAIN: ' @Metacognixion.com ' } as NodeJS.ProcessEnv),
    ).toBe('metacognixion.com');
    expect(staffEmailDomain({} as NodeJS.ProcessEnv)).toBeNull();
    expect(staffEmailDomain({ STAFF_ALLOWED_EMAIL_DOMAIN: '' } as NodeJS.ProcessEnv)).toBeNull();
  });
});
