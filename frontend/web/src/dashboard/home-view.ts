import type { AgentSummary, MemberRole, SentimentCounts, WorkspaceChecklist, WorkspaceResponse } from '@portal/schemas';
import { roleAtLeast } from '@portal/schemas';
import { agentPath, routes, settingsPath } from '../routes';

/**
 * D1 Home and the §7.2 shell as pure decisions (ADR 0041): what the credits card says a
 * balance is worth, the unpublished-changes chip, the pause notices, the checklist rows
 * and which buttons an agent card offers a role. The components render these; nothing
 * here reads a hook, so every rule is a plain test.
 */

export interface CreditsOutlook {
  /** The balance as minutes of a Standard agent (spec §7.2 "≈ minutes"), never negative. */
  minutes: number;
  /** Credits spent per day over the window the burn was measured on. */
  burnPerDay: number;
  /**
   * Days until the balance runs out at that burn (spec p. 33: balance ÷ 7-day average).
   * `null` = no usage in the window, so there is nothing to divide by; 0 = already out.
   */
  daysLeft: number | null;
}

/** `burn` is the credits used over `days` whole days (`GET /stats?range=7d`). Non-numbers count as 0. */
export function creditsOutlook(input: { balance: number; standardRatePerMin: number; burn: number; days?: number }): CreditsOutlook {
  const balance = finite(input.balance);
  const rate = finite(input.standardRatePerMin);
  const days = Math.max(1, finite(input.days ?? 7));
  const burnPerDay = round1(Math.max(0, finite(input.burn)) / days);
  const minutes = balance > 0 && rate > 0 ? Math.floor(balance / rate) : 0;
  const daysLeft = balance <= 0 ? 0 : burnPerDay > 0 ? Math.floor(balance / burnPerDay) : null;
  return { minutes, burnPerDay, daysLeft };
}

export interface SentimentShare {
  total: number;
  /** Positive calls as a whole percentage of the calls with a known sentiment; null until there is one. */
  positivePct: number | null;
  negativePct: number | null;
}

/** "😊 86 % positive" (spec p. 33) from the counts `GET /stats` answers. Unknown sentiment is left out of the share. */
export function sentimentShare(counts: SentimentCounts | null | undefined): SentimentShare {
  const positive = finite(counts?.positive);
  const neutral = finite(counts?.neutral);
  const negative = finite(counts?.negative);
  const known = positive + neutral + negative;
  const total = known + finite(counts?.unknown);
  if (known <= 0) return { total, positivePct: null, negativePct: null };
  return { total, positivePct: Math.round((positive / known) * 100), negativePct: Math.round((negative / known) * 100) };
}

export interface UnpublishedSummary {
  count: number;
  /** One agent: its Test tab, where Publish is (§7.2). Several: the agents list. */
  href: string;
}

/** §7.2 "appears when any agent's draft version ≠ published version". Null = no chip. */
export function unpublishedSummary(agents: ReadonlyArray<Pick<AgentSummary, 'id' | 'has_unpublished_changes'>> | undefined): UnpublishedSummary | null {
  const changed = (agents ?? []).filter((a) => a.has_unpublished_changes);
  if (changed.length === 0) return null;
  return { count: changed.length, href: changed.length === 1 ? agentPath(changed[0]!.id, 'test') : routes.app.agents };
}

export interface PauseNotice {
  /** A workspace is only ever paused by staff (SA2); an agent by the customer (D3) or staff. */
  by: 'staff' | 'customer' | 'unknown';
  ticketId: number | null;
}

/** The D1 banner's "Your account is paused — see ticket #…" (spec p. 33). Null while not paused. */
export function workspacePauseNotice(workspace: Pick<WorkspaceResponse, 'paused' | 'paused_ticket_id'> | null | undefined): PauseNotice | null {
  if (!workspace?.paused) return null;
  return { by: 'staff', ticketId: positiveInt(workspace.paused_ticket_id) };
}

/** The same for an agent card. A pause recorded before `paused_by` existed is `unknown` and says only "Paused". */
export function agentPauseNotice(agent: Pick<AgentSummary, 'status' | 'paused_by' | 'paused_ticket_id'>): PauseNotice | null {
  if (agent.status !== 'paused') return null;
  if (agent.paused_by === 'staff') return { by: 'staff', ticketId: positiveInt(agent.paused_ticket_id) };
  if (agent.paused_by === 'customer') return { by: 'customer', ticketId: null };
  return { by: 'unknown', ticketId: null };
}

export interface AgentCardActions {
  /** D3 Test tab (editor and up — a viewer cannot place a test call). */
  test: boolean;
  /** Publish is offered when there is a draft with a script that is not live yet. Editor and up. */
  publish: boolean;
  /** Editors open the Brief to edit; viewers open the overview to look. */
  edit: 'edit' | 'view';
  testHref: string;
  editHref: string;
}

/** Spec p. 33: "[Test] [Publish] [Edit]; Viewer sees no Top up/Publish buttons". The API enforces each again. */
export function agentCardActions(agent: Pick<AgentSummary, 'id' | 'has_unpublished_changes' | 'draft_has_prompt' | 'published_version'>, role: MemberRole): AgentCardActions {
  const canEdit = roleAtLeast(role, 'editor');
  const draftAhead = agent.has_unpublished_changes || agent.published_version === null;
  return {
    test: canEdit,
    publish: canEdit && draftAhead && agent.draft_has_prompt,
    edit: canEdit ? 'edit' : 'view',
    testHref: agentPath(agent.id, 'test'),
    editHref: agentPath(agent.id, canEdit ? 'brief' : 'overview'),
  };
}

/** Who may open the wallet's Top up (§5, owner/admin — the API's `POST /wallet/checkout` roles). */
export function canTopUp(role: MemberRole): boolean {
  return roleAtLeast(role, 'admin');
}

export type ChecklistKey = Exclude<keyof WorkspaceChecklist, 'onboarding_step' | 'complete' | 'all_done'>;

export interface ChecklistRow {
  key: ChecklistKey;
  done: boolean;
  href: string;
}

/** The rows in wizard order, each linking to where it is done. A forwarding row only exists when a number forwards. */
export function checklistRows(checklist: WorkspaceChecklist): { rows: ChecklistRow[]; done: number; total: number } {
  const all: Array<{ key: ChecklistKey; href: string; applies: boolean }> = [
    { key: 'workspace_created', href: routes.app.settings, applies: true },
    { key: 'agent_created', href: routes.app.agents, applies: true },
    { key: 'agent_generated', href: routes.app.agents, applies: true },
    { key: 'agent_published', href: routes.app.agents, applies: true },
    { key: 'credits_purchased', href: routes.app.wallet, applies: true },
    { key: 'number_attached', href: routes.app.numbers, applies: true },
    { key: 'forwarding_tested', href: routes.app.numbers, applies: checklist.forwarding_tested !== null },
    { key: 'team_invited', href: settingsPath('team'), applies: true },
  ];
  const rows = all.filter((r) => r.applies).map((r) => ({ key: r.key, href: r.href, done: checklist[r.key] === true }));
  return { rows, done: rows.filter((r) => r.done).length, total: rows.length };
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
