import { describe, expect, it } from 'vitest';
import { carrier } from '@portal/schemas';
import { forwardingGuideFor } from './forwarding-guide';

describe('forwardingGuideFor', () => {
  it('has a guide for every carrier the schema knows, with the destination filled in', () => {
    for (const c of carrier.options) {
      const guide = forwardingGuideFor(c, '+14505550123');
      expect(guide.carrier).toBe(c);
      expect(guide.steps.length).toBeGreaterThan(0);
      expect(guide.disable_steps.length).toBeGreaterThan(0);
      expect(JSON.stringify(guide)).not.toContain('{destination}');
      expect(JSON.stringify(guide)).toContain('+14505550123');
    }
  });

  it('falls back to a placeholder before the number exists', () => {
    expect(forwardingGuideFor('bell', null).steps.join(' ')).toContain('your new number');
  });
});
