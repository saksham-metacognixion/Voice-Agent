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
  /** D17 §11.5: the website widget's frame, `?key=` — public, outside every guard and provider but theme and language. */
  embed: '/embed/',
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

/**
 * `onboarding_step` as the wizard reads it: a step with no page of its own counts as the
 * next one that has one (4 → 5), so the page `stepPath` sends a workspace to is one its
 * guard lets in (QA-004: a workspace left on 4 was sent to W5, which needs 5, and waited
 * there for ever). Past the last page it is left as it is — that is the dashboard's.
 */
export function effectiveStep(step: number): number {
  return ONBOARDING_STEPS.find((s) => s.step >= step)?.step ?? step;
}

/** Whether wizard page W-`page` may be shown to a workspace on `onboarding_step`. No skipping ahead. */
export function stepAllowed(page: number, onboardingStep: number): boolean {
  return page <= effectiveStep(onboardingStep);
}

/** Same page, whether or not either path carries the export's trailing slash. */
export function samePath(a: string, b: string): boolean {
  const trim = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
  return trim(a) === trim(b);
}

export function withNext(path: string, next: string | null | undefined): string {
  if (!next || next === '/' || !next.startsWith('/')) return path;
  return `${path}?next=${encodeURIComponent(next)}`;
}

/** A stand-in origin to resolve `next` against; only "did it stay on it" is ever read. */
const SAME_ORIGIN = 'https://portal.invalid';

/**
 * Only ever send people to a path on this origin (QA-001). Refused, for the fallback:
 * anything not starting with one `/` (`https://evil`, `//evil`, `javascript:`), a
 * backslash (`/\evil` is `//evil` to a browser), control characters or whitespace, a
 * value that does not parse or resolves off the origin, and the sign-in pages themselves
 * — a signed-in person sent to /login with `next=/login/` would bounce for ever.
 * What comes back is the normalised path, query and fragment, so `?token=` survives.
 */
export function safeNext(value: string | null | undefined, fallback: string): string {
  if (!value || value.length > 2048) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, SAME_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== SAME_ORIGIN) return fallback;
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  if (path === routes.login || path === routes.signup) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Where a signed-in person goes from `/` after the Auth0 callback, or from /login and
 * /signup: the validated return path when there is one, else where the §6.4 gate says
 * they belong (`/app/` once onboarded). The return page's own guards still decide — a
 * wizard step, verification, a missing workspace — so a deep link never skips the gate.
 */
export function signedInDestination(returnTo: string | null | undefined, gateDestination: string | null): string | null {
  const next = safeNext(returnTo, '');
  if (next && next !== routes.root) return next;
  return gateDestination;
}

/**
 * Where switching workspace lands (QA-013): the page's own validated `?next=` when it has
 * one — /select-workspace is reached with the page that sent the person there — else `/`,
 * whose gate knows where the *new* workspace belongs. Never the current page: it is the
 * old workspace's agent, number or wizard step.
 */
export function switchWorkspaceDestination(query: URLSearchParams): string {
  return safeNext(query.get('next'), routes.root);
}

/** D3 agent tabs, in the order the spec lists them (p. 36). */
export const AGENT_TABS = ['overview', 'brief', 'prompt', 'voice', 'knowledge', 'test', 'website', 'versions', 'settings'] as const;
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
