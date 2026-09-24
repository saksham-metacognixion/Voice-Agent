/**
 * The sitemap (spec §7.1) as constants, so a moved page is one edit. Every path ends with
 * a slash to match `trailingSlash: true` in the export.
 */
export const routes = {
  root: '/',
  login: '/login/',
  signup: '/signup/',
  verifyEmail: '/verify-email/',
  forgotPassword: '/forgot-password/',
  resetPassword: '/reset-password/',
  mfa: '/mfa/',
  /** `/invite/[token]` in the spec; a static export cannot serve an arbitrary segment, so the token is `?token=`. */
  invite: '/invite/',
  selectWorkspace: '/select-workspace/',
  setupWorkspace: '/setup/workspace/',
  onboarding: {
    template: '/onboarding/template/',
    brief: '/onboarding/brief/',
    voice: '/onboarding/voice/',
    knowledge: '/onboarding/knowledge/',
    test: '/onboarding/test/',
    phone: '/onboarding/phone/',
    activate: '/onboarding/activate/',
    /** After W7: the agent answers calls. Outside the 1–7 step sequence, gated on the activation itself. */
    live: '/onboarding/live/',
  },
  app: {
    home: '/app/',
    calls: '/app/calls/',
    agents: '/app/agents/',
    /** `/app/agents/[id]/*` in the spec (D3); a static export cannot serve the segment, so it is `?id=&tab=`. */
    agentDetail: '/app/agents/detail/',
    numbers: '/app/numbers/',
    wallet: '/app/wallet/',
    settings: '/app/settings/',
    help: '/app/help/',
  },
} as const;

/** `tenants.onboarding_step` (1–7) → wizard page. Step N is "the customer is on W-N". */
export const ONBOARDING_STEPS = [
  { step: 1, key: 'template', path: routes.onboarding.template },
  { step: 2, key: 'brief', path: routes.onboarding.brief },
  { step: 3, key: 'voice', path: routes.onboarding.voice },
  { step: 4, key: 'knowledge', path: routes.onboarding.knowledge },
  { step: 5, key: 'test', path: routes.onboarding.test },
  { step: 6, key: 'phone', path: routes.onboarding.phone },
  { step: 7, key: 'activate', path: routes.onboarding.activate },
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number]['key'];

/**
 * The last wizard step with a real page. W1–W3 shipped in D8, W4–W7 in D9, so the
 * dashboard now opens only once onboarding is complete (`onboarding_completed_at`, set
 * by the activation job's `mark_live`). Kept as a constant so a future step can land
 * behind it the same way.
 */
export const LAST_IMPLEMENTED_STEP = 7;

export function stepPath(step: number): string {
  const clamped = Math.min(Math.max(step, 1), ONBOARDING_STEPS.length);
  return ONBOARDING_STEPS[clamped - 1]!.path;
}

export function stepIndex(key: OnboardingStepKey): number {
  return ONBOARDING_STEPS.findIndex((s) => s.key === key);
}

export function withNext(path: string, next: string | null | undefined): string {
  if (!next || next === '/' || !next.startsWith('/')) return path;
  return `${path}?next=${encodeURIComponent(next)}`;
}

/** Only ever send people to a path on this origin; `//evil` and `https://` are refused. */
export function safeNext(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('://')) return fallback;
  return value;
}

/** D3 agent tabs, in the order the spec lists them (p. 36). */
export const AGENT_TABS = ['overview', 'brief', 'prompt', 'voice', 'knowledge', 'test', 'versions', 'settings'] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

export function agentPath(agentId: string, tab: AgentTab = 'overview'): string {
  const query = new URLSearchParams({ id: agentId });
  if (tab !== 'overview') query.set('tab', tab);
  return `${routes.app.agentDetail}?${query.toString()}`;
}

/** D2's detail drawer: `/app/calls/[id]` in the spec, `?call=` in the export. */
export function callPath(callId: string): string {
  return `${routes.app.calls}?call=${encodeURIComponent(callId)}`;
}
