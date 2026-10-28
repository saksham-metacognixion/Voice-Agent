import type { KycDetails } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { callerIdAction, callerIdLabel, customerReasonValid, kycActions, kycStatusVariant } from './compliance';

const DETAILS: KycDetails = {
  legal_name: 'Maple Dental Ltd',
  registration_number: 'BC1234567',
  registration_country: 'CA',
  address: '1 Main St, Vancouver BC',
  contact_name: 'Jo Smith',
  dnc_registration: null,
};

describe('kycActions', () => {
  it('offers approve and reject for a pending submission', () => {
    expect(kycActions({ status: 'pending', details: DETAILS })).toEqual({ approve: true, reject: 'reject' });
  });

  it('offers withdraw, not approve, for a verified business', () => {
    expect(kycActions({ status: 'verified', details: DETAILS })).toEqual({ approve: false, reject: 'withdraw' });
  });

  it('offers approve for a rejection that still has details, and nothing to reject', () => {
    expect(kycActions({ status: 'rejected', details: DETAILS })).toEqual({ approve: true, reject: null });
    expect(kycActions({ status: 'rejected', details: null })).toEqual({ approve: false, reject: null });
  });

  it('offers nothing before a submission (approving would be a 409)', () => {
    expect(kycActions({ status: 'none', details: null })).toEqual({ approve: false, reject: null });
  });

  it('tones the status badge', () => {
    expect(kycStatusVariant('verified')).toBe('success');
    expect(kycStatusVariant('pending')).toBe('warning');
    expect(kycStatusVariant('rejected')).toBe('danger');
    expect(kycStatusVariant('none')).toBe('outline');
  });
});

describe('customerReasonValid', () => {
  it('needs 1–300 characters after trimming', () => {
    expect(customerReasonValid('   ')).toBe(false);
    expect(customerReasonValid('The registration number does not match the registry.')).toBe(true);
    expect(customerReasonValid('x'.repeat(300))).toBe(true);
    expect(customerReasonValid('x'.repeat(301))).toBe(false);
  });
});

describe('caller ID', () => {
  const live = { e164: '+16045550100', status: 'active' as const };

  it('labels how a number was verified', () => {
    expect(callerIdLabel({ caller_id_verified: true, caller_id_verified_via: 'purchase' })).toBe('Verified (bought)');
    expect(callerIdLabel({ caller_id_verified: true, caller_id_verified_via: 'staff' })).toBe('Verified (staff)');
    expect(callerIdLabel({ caller_id_verified: false, caller_id_verified_via: null })).toBe('Not verified');
  });

  it('offers revoke for any verified number', () => {
    expect(callerIdAction({ ...live, caller_id_verified: true, caller_id_verified_via: 'purchase' })).toBe('revoke');
    expect(callerIdAction({ e164: '+16045550100', status: 'released', caller_id_verified: true, caller_id_verified_via: 'staff' })).toBe('revoke');
  });

  it('offers verify only for a live number', () => {
    expect(callerIdAction({ ...live, caller_id_verified: false, caller_id_verified_via: null })).toBe('verify');
    expect(callerIdAction({ e164: '+16045550100', status: 'paused', caller_id_verified: false, caller_id_verified_via: null })).toBe('verify');
    expect(callerIdAction({ e164: null, status: 'provisioning', caller_id_verified: false, caller_id_verified_via: null })).toBeNull();
    expect(callerIdAction({ e164: '+16045550100', status: 'released', caller_id_verified: false, caller_id_verified_via: null })).toBeNull();
    expect(callerIdAction({ e164: '+16045550100', status: 'failed', caller_id_verified: false, caller_id_verified_via: null })).toBeNull();
  });
});
