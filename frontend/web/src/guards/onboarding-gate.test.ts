import { describe, expect, it } from 'vitest';
import { routes } from '../routes';
import { onboardingGate } from './session-gate';

/*
 * §6.4 "Workspace has no published agent and onboarding not dismissed → /onboarding/*".
 * "Save and exit" (§7.3) is the dismissal (ADR 0039 §1).
 */

const ws = (step: number, completed: string | null = null, dismissed: string | null = null) => ({
  onboarding_step: step,
  onboarding_completed_at: completed,
  onboarding_dismissed_at: dismissed,
});

describe('onboardingGate', () => {
  it('sends an unfinished, undismissed workspace to its step', () => {
    const gate = onboardingGate(ws(2));
    expect(gate.dashboardAllowed).toBe(false);
    expect(gate.destination).toBe(routes.onboarding.brief);
  });

  it('opens the dashboard once the wizard was dismissed, whatever the step', () => {
    for (const step of [1, 2, 3, 5, 6, 7]) {
      const gate = onboardingGate(ws(step, null, '2026-11-05T09:00:00.000Z'));
      expect(gate.dashboardAllowed).toBe(true);
      expect(gate.destination).toBe(routes.app.home);
      expect(gate.onboardingComplete).toBe(false);
      expect(gate.onboardingStep).toBe(step);
    }
  });

  it('opens the dashboard once onboarding is complete', () => {
    const gate = onboardingGate(ws(7, '2026-11-05T09:00:00.000Z'));
    expect(gate.dashboardAllowed).toBe(true);
    expect(gate.onboardingComplete).toBe(true);
  });

  it('keeps sending a workspace left on the unused step 4 to W5', () => {
    expect(onboardingGate(ws(4)).destination).toBe(routes.onboarding.test);
  });
});
