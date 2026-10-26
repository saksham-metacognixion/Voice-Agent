import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS, callPath, effectiveStep, routes, safeNext, samePath, signedInDestination, stepAllowed, stepPath, switchWorkspaceDestination, withNext } from './routes';

describe('safeNext (QA-001)', () => {
  it('keeps a same-origin path with its query, so a deep link and an invite token survive', () => {
    expect(safeNext(callPath('call_123'), '/')).toBe('/app/calls/?call=call_123');
    expect(safeNext('/invite/?token=abc.DEF-123', '/')).toBe('/invite/?token=abc.DEF-123');
    expect(safeNext(routes.mfa, '/')).toBe('/mfa/');
    expect(safeNext('/app/agents/detail/?id=a1&tab=prompt#top', '/')).toBe('/app/agents/detail/?id=a1&tab=prompt#top');
  });

  it('round-trips what withNext encodes', () => {
    const login = withNext(routes.login, '/invite/?token=X&from=email');
    const next = new URL(login, 'https://app.example').searchParams.get('next');
    expect(safeNext(next, '/')).toBe('/invite/?token=X&from=email');
  });

  it.each([
    ['https://evil.example/app/'],
    ['http://evil.example'],
    ['//evil.example'],
    ['//evil.example/app/'],
    ['/\\evil.example'],
    ['\\\\evil.example'],
    ['/\t/evil.example'],
    ['/\n/evil.example'],
    [' /app/'],
    ['javascript:alert(1)'],
    ['data:text/html,hi'],
    ['app/'],
    ['?next=/app/'],
    ['#/app/'],
    [`/${'a'.repeat(2100)}`],
  ])('refuses %j', (value) => {
    expect(safeNext(value, '/app/')).toBe('/app/');
  });

  it('refuses the sign-in pages themselves, which would bounce a signed-in person for ever', () => {
    expect(safeNext('/login/', '/')).toBe('/');
    expect(safeNext('/login', '/')).toBe('/');
    expect(safeNext('/login/?next=/app/', '/')).toBe('/');
    expect(safeNext('/signup/', '/')).toBe('/');
  });

  it('falls back on nothing', () => {
    expect(safeNext(null, '/app/')).toBe('/app/');
    expect(safeNext(undefined, '/app/')).toBe('/app/');
    expect(safeNext('', '/app/')).toBe('/app/');
  });
});

describe('signedInDestination (QA-001)', () => {
  it('prefers a valid return path over the gate, so the gate cannot overwrite it with /app/', () => {
    expect(signedInDestination('/app/calls/?call=c1', routes.app.home)).toBe('/app/calls/?call=c1');
    expect(signedInDestination('/invite/?token=X', routes.app.home)).toBe('/invite/?token=X');
    expect(signedInDestination('/mfa/', routes.app.home)).toBe('/mfa/');
  });

  it('does not wait for the gate when there is a return path', () => {
    expect(signedInDestination('/invite/?token=X', null)).toBe('/invite/?token=X');
  });

  it('is the gate destination without a return path — an ordinary sign-in still lands on /app/', () => {
    expect(signedInDestination(null, routes.app.home)).toBe('/app/');
    expect(signedInDestination(undefined, routes.app.home)).toBe('/app/');
    expect(signedInDestination('/', routes.app.home)).toBe('/app/');
    expect(signedInDestination(null, routes.onboarding.brief)).toBe(routes.onboarding.brief);
    expect(signedInDestination(null, null)).toBeNull();
  });

  it('ignores an unsafe return path and uses the gate', () => {
    expect(signedInDestination('//evil.example', routes.app.home)).toBe('/app/');
    expect(signedInDestination('https://evil.example/app/', routes.app.home)).toBe('/app/');
    expect(signedInDestination('/login/', routes.app.home)).toBe('/app/');
  });
});

// BUG-008: /, after sign-in, prefers the sign-in's own return path, then a remembered
// invite, then the gate — so an invitee with no workspace is not sent to create one.
describe('signedInDestination with a remembered invite (BUG-008)', () => {
  it('sends a signed-in invitee without a workspace to the invite, not to setup', () => {
    const returnTo: string | null = null;
    expect(signedInDestination(returnTo ?? '/invite/?token=abc', routes.setupWorkspace)).toBe('/invite/?token=abc');
  });

  it('lets the sign-in’s own return path win over a remembered invite', () => {
    const returnTo: string | null = '/app/calls/';
    expect(signedInDestination(returnTo ?? '/invite/?token=abc', routes.app.home)).toBe('/app/calls/');
  });

  it('falls back to the gate with neither', () => {
    expect(signedInDestination(null, routes.setupWorkspace)).toBe(routes.setupWorkspace);
  });

  it('carries the invite through the sign-in/sign-up links and verification intact', () => {
    const invite = '/invite/?token=abc_DEF-123';
    for (const page of [routes.signup, routes.login, routes.verifyEmail]) {
      const next = new URL(withNext(page, invite), 'https://app.example').searchParams.get('next');
      expect(safeNext(next, routes.root)).toBe(invite);
    }
  });
});

describe('wizard step gating (QA-004)', () => {
  it('reads a step with no page as the next one that has one', () => {
    expect(effectiveStep(4)).toBe(5);
    for (const { step } of ONBOARDING_STEPS) expect(effectiveStep(step)).toBe(step);
    expect(effectiveStep(8)).toBe(8);
  });

  it('lets every workspace into the page stepPath sends it to — step 4 resumes on W5', () => {
    for (let step = 1; step <= 7; step += 1) {
      const page = ONBOARDING_STEPS.find((s) => s.path === stepPath(step))!;
      expect(stepAllowed(page.step, step)).toBe(true);
    }
    expect(stepPath(4)).toBe(routes.onboarding.test);
    expect(stepAllowed(5, 4)).toBe(true);
  });

  it('still refuses skipping ahead', () => {
    expect(stepAllowed(6, 4)).toBe(false);
    expect(stepAllowed(5, 3)).toBe(false);
    expect(stepAllowed(3, 5)).toBe(true);
  });

  it('compares paths with or without the trailing slash', () => {
    expect(samePath('/onboarding/test', routes.onboarding.test)).toBe(true);
    expect(samePath('/', '/')).toBe(true);
    expect(samePath('/onboarding/test/', routes.onboarding.phone)).toBe(false);
  });
});

describe('switchWorkspaceDestination (QA-013)', () => {
  const q = (s: string) => new URLSearchParams(s);

  it('keeps the page\'s own ?next= through the switch', () => {
    expect(switchWorkspaceDestination(q(`next=${encodeURIComponent(callPath('call_9'))}`))).toBe('/app/calls/?call=call_9');
    expect(switchWorkspaceDestination(q(`next=${encodeURIComponent('/invite/?token=abc')}`))).toBe('/invite/?token=abc');
    expect(switchWorkspaceDestination(q(`next=${encodeURIComponent(stepPath(2))}`))).toBe(stepPath(2));
  });

  it('otherwise goes to /, whose gate places the new workspace — never the old workspace\'s page', () => {
    expect(switchWorkspaceDestination(q(''))).toBe(routes.root);
    expect(switchWorkspaceDestination(q('id=agent_of_the_old_workspace&tab=prompt'))).toBe(routes.root);
  });

  it('refuses a next= that leaves the origin or loops to sign-in', () => {
    expect(switchWorkspaceDestination(q('next=https://evil.example'))).toBe(routes.root);
    expect(switchWorkspaceDestination(q('next=//evil.example'))).toBe(routes.root);
    expect(switchWorkspaceDestination(q('next=/login/'))).toBe(routes.root);
  });
});
