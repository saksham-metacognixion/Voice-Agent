import { afterEach, describe, expect, it } from 'vitest';
import { activeCall, guardNavigation, interceptsNavigation, leaveRequest } from './leave-call';

const here = { href: 'https://app.example.test/onboarding/test/', origin: 'https://app.example.test' };
const click = (over: Partial<Parameters<typeof interceptsNavigation>[0]>) => ({ href: '/onboarding/phone/', target: null, download: false, modified: false, defaultPrevented: false, ...over });

describe('interceptsNavigation', () => {
  it('asks before a link to another page of the portal, or to another site', () => {
    expect(interceptsNavigation(click({}), here)).toBe(true);
    expect(interceptsNavigation(click({ href: 'https://example.com/' }), here)).toBe(true);
  });

  it('leaves alone what does not tear the page down', () => {
    expect(interceptsNavigation(click({ href: '#transcript' }), here)).toBe(false);
    expect(interceptsNavigation(click({ href: '/onboarding/test/?x=1#y', }), { ...here, href: 'https://app.example.test/onboarding/test/?x=1' })).toBe(false);
    expect(interceptsNavigation(click({ target: '_blank' }), here)).toBe(false);
    expect(interceptsNavigation(click({ modified: true }), here)).toBe(false);
    expect(interceptsNavigation(click({ download: true }), here)).toBe(false);
    expect(interceptsNavigation(click({ defaultPrevented: true }), here)).toBe(false);
    expect(interceptsNavigation(click({ href: 'mailto:support@oraly.ai' }), here)).toBe(false);
    expect(interceptsNavigation(click({ href: 'tel:+14165550100' }), here)).toBe(false);
    expect(interceptsNavigation(click({ href: null }), here)).toBe(false);
  });
});

describe('guardNavigation', () => {
  afterEach(() => activeCall.set(false, () => undefined));

  it('runs the navigation at once when no call is live', () => {
    let ran = 0;
    expect(guardNavigation(() => (ran += 1))).toBe(true);
    expect(ran).toBe(1);
    expect(leaveRequest.get()).toBeNull();
  });

  it('parks it behind the prompt while a call is live; Stay forgets it, Leave hangs up then goes', () => {
    let hungUp = 0;
    let ran = 0;
    activeCall.set(true, () => (hungUp += 1));
    expect(guardNavigation(() => (ran += 1))).toBe(false);
    expect(ran).toBe(0);
    expect(leaveRequest.get()).not.toBeNull();
    leaveRequest.stay();
    expect(leaveRequest.get()).toBeNull();
    expect(ran).toBe(0);
    guardNavigation(() => (ran += 1));
    leaveRequest.leave();
    expect(hungUp).toBe(1);
    expect(ran).toBe(1);
  });

  it('a call that ends on its own drops a pending request', () => {
    activeCall.set(true, () => undefined);
    guardNavigation(() => undefined);
    activeCall.set(false, () => undefined);
    expect(leaveRequest.get()).toBeNull();
  });
});
