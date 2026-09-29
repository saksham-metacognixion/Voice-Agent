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
  /** Admin §7.4 (D12): where the console's "View as" lands — `#session=&key=` (the fragment, never logged), kept for the tab. */
  impersonate: '/impersonate/',
  selectWorkspace: '/select-workspace/',
  setupWorkspace: '/setup/workspace/',
  onboarding: {
    template: '/onboarding/template/',
    brief: '/onboarding/brief/',
    voice: '/onboarding/voice/',
    /** After payment (ADR 0024): the first page once the agent is live, then `live`. */
    knowledge: '/onboarding/knowledge/',
    test: '/onboarding/test/',
    phone: '/onboarding/phone/',
    activate: '/onboarding/activate/',
    /** After W7 and knowledge: the agent answers calls. Outside the 1–7 step sequence, gated on the activation itself. */
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

/**
 * `tenants.onboarding_step` (1–7) → wizard page, before payment. Step N is "the customer
 * is on W-N". W4 (knowledge) is not in it: what the agent knows is a paid-pack feature,
 * so it comes after payment, once the agent is live (ADR 0024). The numbers are kept —
 * the API, the activation job (`mark_live` writes 7) and the SA1 funnel count on them —
 * so 4 is unused and a workspace left on 4 by an older build resumes on W5.
 */
export const ONBOARDING_STEPS = [
  { step: 1, key: 'template', path: routes.onboarding.template },
  { step: 2, key: 'brief', path: routes.onboarding.brief },
  { step: 3, key: 'voice', path: routes.onboarding.voice },
  { step: 5, key: 'test', path: routes.onboarding.test },
  { step: 6, key: 'phone', path: routes.onboarding.phone },
  { step: 7, key: 'activate', path: routes.onboarding.activate },
] as const;

/** What the stepper draws: the numbered steps, then knowledge, reachable once onboarding is complete. */
export const WIZARD_STEPPER = [...ONBOARDING_STEPS, { step: null, key: 'knowledge', path: routes.onboarding.knowledge }] as const;

export type OnboardingStepKey = (typeof WIZARD_STEPPER)[number]['key'];

/**
 * The last wizard step with a real page. W1–W3 shipped in D8, W4–W7 in D9, so the
 * dashboard now opens only once onboarding is complete (`onboarding_completed_at`, set
 * by the activation job's `mark_live`). Kept as a constant so a future step can land
 * behind it the same way.
 */
export const LAST_IMPLEMENTED_STEP = 7;

/** The page for `onboarding_step`: that step's, or the next one that exists (4 → W5). */
export function stepPath(step: number): string {
  const found = ONBOARDING_STEPS.find((s) => s.step >= step) ?? ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1]!;
  return found.path;
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

/** D4 detail sections (spec p. 37). Forwarding and SIP only exist for numbers of that type. */
export const NUMBER_TABS = ['routing', 'handoff', 'callers', 'forwarding', 'sip', 'danger'] as const;
export type NumberTab = (typeof NUMBER_TABS)[number];

/** `/app/numbers/[id]` in the spec (D4); `?id=&tab=` in the export, like D3. */
export function numberPath(numberId: string, tab: NumberTab = 'routing'): string {
  const query = new URLSearchParams({ id: numberId });
  if (tab !== 'routing') query.set('tab', tab);
  return `${routes.app.numbers}?${query.toString()}`;
}

/** D6 sub-pages (spec p. 39), in the order the spec lists them. `/app/settings/*` → `?tab=`. */
export const SETTINGS_TABS = ['workspace', 'team', 'notifications', 'security', 'privacy', 'audit'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function settingsPath(tab: SettingsTab = 'workspace'): string {
  return tab === 'workspace' ? routes.app.settings : `${routes.app.settings}?tab=${tab}`;
}
