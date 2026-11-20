import { describe, expect, it } from 'vitest';
import { sipGuideSteps } from './sip-guide';

describe('sipGuideSteps', () => {
  it('walks the trunk, the origination address, the transport, the number and a test call', () => {
    expect(sipGuideSteps('twilio')).toEqual(['open_trunk', 'origination', 'transport', 'number', 'test']);
    expect(sipGuideSteps('other')).toEqual(['open_trunk', 'origination', 'transport', 'number', 'test']);
  });

  it('leaves out the transport step where the provider has no such switch', () => {
    expect(sipGuideSteps('telnyx')).not.toContain('transport');
  });
});
