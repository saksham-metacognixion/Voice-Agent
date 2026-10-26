import { useAuth } from '../auth/auth-provider';
import { useWorkspace } from '../workspace/workspace-provider';
import { LAST_IMPLEMENTED_STEP, routes, stepPath, withNext } from '../routes';

/**
 * §6.4 onboarding gating, computed from the session in one place. Every guarded layout
 * asks "where should this person be?" and compares with where they are:
 *
 *   anonymous            → /login?next=…
 *   email not confirmed  → /verify-email
 *   no workspace         → /setup/workspace
 *   several, none chosen → /select-workspace
 *   onboarding_step ≤ N  → /onboarding/<step>   (N = last implemented step)
 *   otherwise            → /app
 *
 * `null` means "still resolving" and the caller shows a loader — never protected content.
 */
export type GateArea = 'auth' | 'onboarding' | 'app';

export interface GateResult {
  ready: boolean;
  /** Where the person belongs given their state. */
  destination: string | null;
  onboardingStep: number | null;
  /** `tenants.onboarding_completed_at` is set: the wizard is over. */
  onboardingComplete: boolean;
  /** The dashboard may be shown: onboarding is complete, or past the last implemented step. */
  dashboardAllowed: boolean;
  /** The workspace row is being re-read; a redirect decided now could be on stale data. */
  settling: boolean;
  /**
   * Ready, but the answer could not be read: the workspace list or the active workspace
   * failed to load. `destination` is null then, so a page that only follows the gate must
   * show an error and a retry rather than wait (QA-012).
   */
  failed?: 'memberships' | 'workspace';
}

export function useSessionGate(currentPath: string): GateResult {
  const auth = useAuth();
  const ws = useWorkspace();

  if (auth.status === 'loading') return { ready: false, destination: null, onboardingStep: null, onboardingComplete: false, dashboardAllowed: false, settling: false };
  if (auth.status === 'anonymous') {
    return { ready: true, destination: withNext(routes.login, currentPath), onboardingStep: null, onboardingComplete: false, dashboardAllowed: false, settling: false };
  }
  if (!auth.user?.emailVerified) return { ready: true, destination: routes.verifyEmail, onboardingStep: null, onboardingComplete: false, dashboardAllowed: false, settling: false };

  if (ws.status === 'loading' || ws.status === 'idle') return { ready: false, destination: null, onboardingStep: null, onboardingComplete: false, dashboardAllowed: false, settling: false };
  if (ws.status === 'error') return { ready: true, destination: null, onboardingStep: null, onboardingComplete: false, dashboardAllowed: false, settling: false, failed: 'memberships' };
  if (ws.memberships.length === 0) return { ready: true, destination: routes.setupWorkspace, onboardingStep: null, onboardingComplete: false, dashboardAllowed: false, settling: false };
  if (!ws.active) return { ready: true, destination: routes.selectWorkspace, onboardingStep: null, onboardingComplete: false, dashboardAllowed: false, settling: false };

  if (ws.workspaceStatus === 'loading' || ws.workspaceStatus === 'idle') return { ready: false, destination: null, onboardingStep: null, onboardingComplete: false, dashboardAllowed: false, settling: false };
  if (ws.workspaceStatus === 'error' || !ws.workspace) return { ready: true, destination: null, onboardingStep: null, onboardingComplete: false, dashboardAllowed: false, settling: false, failed: 'workspace' };

  const step = ws.workspace.onboarding_step;
  const complete = Boolean(ws.workspace.onboarding_completed_at);
  const dashboardAllowed = complete || step > LAST_IMPLEMENTED_STEP;
  return {
    ready: true,
    destination: dashboardAllowed ? routes.app.home : stepPath(step),
    onboardingStep: step,
    onboardingComplete: complete,
    dashboardAllowed,
    settling: ws.workspaceFetching,
  };
}
