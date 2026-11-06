import { describe, expect, it } from 'vitest';
import { sipOriginationUri } from './sip-origination';

describe('sipOriginationUri', () => {
  it('is null when unset or blank, else the trimmed value', () => {
    expect(sipOriginationUri({})).toBeNull();
    expect(sipOriginationUri({ SIP_ORIGINATION_URI: '   ' })).toBeNull();
    expect(sipOriginationUri({ SIP_ORIGINATION_URI: ' sip:example.sip.provider.net ' })).toBe('sip:example.sip.provider.net');
  });
});
