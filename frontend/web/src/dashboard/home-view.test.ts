import type { AgentSummary, WorkspaceChecklist } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import {
  agentLiveStatus,
  agentCardActions,
  agentPauseNotice,
  canTopUp,
  checklistRows,
  creditsOutlook,
  sentimentShare,
  unpublishedSummary,
  workspacePauseNotice,
} from './home-view';

describe('creditsOutlook (D1 credits card, §7.2 ≈ minutes)', () => {
  it('turns a balance into Standard minutes and days at the 7-day burn', () => {
    expect(creditsOutlook({ balance: 312.4, standardRatePerMin: 1, burn: 245 })).toEqual({ minutes: 312, burnPerDay: 35, daysLeft: 8 });
  });
  it('has no days figure without usage, and zero when the balance is out', () => {
    expect(creditsOutlook({ balance: 100, standardRatePerMin: 1, burn: 0 })).toEqual({ minutes: 100, burnPerDay: 0, daysLeft: null });
    expect(creditsOutlook({ balance: 0, standardRatePerMin: 1, burn: 14 })).toEqual({ minutes: 0, burnPerDay: 2, daysLeft: 0 });
    expect(creditsOutlook({ balance: -4, standardRatePerMin: 1, burn: 14 }).daysLeft).toBe(0);
  });
  it('never answers NaN or Infinity', () => {
    const out = creditsOutlook({ balance: Number.NaN, standardRatePerMin: 0, burn: Number.POSITIVE_INFINITY, days: 0 });
    expect(out).toEqual({ minutes: 0, burnPerDay: 0, daysLeft: 0 });
    expect(creditsOutlook({ balance: 50, standardRatePerMin: Number.NaN, burn: 10 }).minutes).toBe(0);
  });
  it('rounds minutes down at the Premium-free Standard rate', () => {
    expect(creditsOutlook({ balance: 10, standardRatePerMin: 1.5, burn: 0 }).minutes).toBe(6);
  });
});

describe('sentimentShare (D1 today card)', () => {
  it('is the positive share of the calls with a known sentiment', () => {
    expect(sentimentShare({ positive: 6, neutral: 1, negative: 0, unknown: 3 })).toEqual({ total: 10, positivePct: 86, negativePct: 0 });
  });
  it('has no share until a sentiment is known', () => {
    expect(sentimentShare({ positive: 0, neutral: 0, negative: 0, unknown: 2 })).toEqual({ total: 2, positivePct: null, negativePct: null });
    expect(sentimentShare(undefined)).toEqual({ total: 0, positivePct: null, negativePct: null });
  });
});

describe('unpublishedSummary (§7.2 chip)', () => {
  const agent = (id: string, changed: boolean) => ({ id, has_unpublished_changes: changed });
  it('is nothing while every draft is live', () => {
    expect(unpublishedSummary([agent('a', false)])).toBeNull();
    expect(unpublishedSummary(undefined)).toBeNull();
  });
  it('opens the one agent on its Test tab, several on the list', () => {
    expect(unpublishedSummary([agent('a', true), agent('b', false)])).toEqual({ count: 1, href: '/app/agents/detail/?id=a&tab=test' });
    expect(unpublishedSummary([agent('a', true), agent('b', true)])).toEqual({ count: 2, href: '/app/agents/' });
  });
});

describe('agentLiveStatus (§7.2 "Agent live")', () => {
  const agent = (id: string, status: 'live' | 'draft' | 'paused') => ({ id, status });
  const open = { workspacePaused: false, outOfCredits: false };
  it('is live while a published agent can answer, and opens that agent', () => {
    expect(agentLiveStatus({ agents: [agent('a', 'live'), agent('b', 'draft')], ...open })).toEqual({ state: 'live', count: 1, href: '/app/agents/detail/?id=a' });
  });
  it('counts several live agents and opens the list', () => {
    expect(agentLiveStatus({ agents: [agent('a', 'live'), agent('b', 'live'), agent('c', 'paused')], ...open })).toEqual({ state: 'live', count: 2, href: '/app/agents/' });
  });
  it('reads paused when the workspace is paused or the wallet is out, whatever the agent says', () => {
    expect(agentLiveStatus({ agents: [agent('a', 'live')], workspacePaused: true, outOfCredits: false })?.state).toBe('paused');
    expect(agentLiveStatus({ agents: [agent('a', 'live')], workspacePaused: false, outOfCredits: true })?.state).toBe('paused');
  });
  it('reads paused when every published agent is paused', () => {
    expect(agentLiveStatus({ agents: [agent('a', 'paused'), agent('b', 'draft')], ...open })).toEqual({ state: 'paused', count: 1, href: '/app/agents/detail/?id=a' });
  });
  it('is nothing with drafts only, no agents, or no answer yet', () => {
    expect(agentLiveStatus({ agents: [agent('a', 'draft')], ...open })).toBeNull();
    expect(agentLiveStatus({ agents: [], ...open })).toBeNull();
    expect(agentLiveStatus({ agents: undefined, ...open })).toBeNull();
  });
});

describe('pause notices (D1 banner and card)', () => {
  it('names staff and the ticket for a workspace pause, and nothing while running', () => {
    expect(workspacePauseNotice({ paused: true, paused_ticket_id: 42 })).toEqual({ by: 'staff', ticketId: 42 });
    expect(workspacePauseNotice({ paused: true, paused_ticket_id: null })).toEqual({ by: 'staff', ticketId: null });
    expect(workspacePauseNotice({ paused: false, paused_ticket_id: 42 })).toBeNull();
    expect(workspacePauseNotice(undefined)).toBeNull();
  });
  it('tells a customer pause from a staff one on an agent, and admits an old row', () => {
    expect(agentPauseNotice({ status: 'paused', paused_by: 'staff', paused_ticket_id: 7 })).toEqual({ by: 'staff', ticketId: 7 });
    expect(agentPauseNotice({ status: 'paused', paused_by: 'customer', paused_ticket_id: 7 })).toEqual({ by: 'customer', ticketId: null });
    expect(agentPauseNotice({ status: 'paused', paused_by: null, paused_ticket_id: null })).toEqual({ by: 'unknown', ticketId: null });
    expect(agentPauseNotice({ status: 'live', paused_by: 'staff', paused_ticket_id: 7 })).toBeNull();
  });
});

describe('agentCardActions and canTopUp (§6.1 on D1)', () => {
  const agent: Pick<AgentSummary, 'id' | 'has_unpublished_changes' | 'draft_has_prompt' | 'published_version'> = { id: 'a', has_unpublished_changes: true, draft_has_prompt: true, published_version: 3 };
  it('offers Test, Publish and Edit to an editor and up', () => {
    for (const role of ['owner', 'admin', 'editor'] as const) {
      expect(agentCardActions(agent, role)).toEqual({ test: true, publish: true, edit: 'edit', testHref: '/app/agents/detail/?id=a&tab=test', editHref: '/app/agents/detail/?id=a&tab=brief' });
    }
  });
  it('offers a viewer only a look', () => {
    expect(agentCardActions(agent, 'viewer')).toEqual({ test: false, publish: false, edit: 'view', testHref: '/app/agents/detail/?id=a&tab=test', editHref: '/app/agents/detail/?id=a' });
  });
  it('withholds Publish while nothing is waiting or the draft has no script', () => {
    expect(agentCardActions({ ...agent, has_unpublished_changes: false }, 'owner').publish).toBe(false);
    expect(agentCardActions({ ...agent, draft_has_prompt: false }, 'owner').publish).toBe(false);
    expect(agentCardActions({ ...agent, has_unpublished_changes: false, published_version: null }, 'owner').publish).toBe(true);
  });
  it('lets owners and admins top up, nobody else', () => {
    expect(canTopUp('owner')).toBe(true);
    expect(canTopUp('admin')).toBe(true);
    expect(canTopUp('editor')).toBe(false);
    expect(canTopUp('viewer')).toBe(false);
  });
});

describe('checklistRows (D1 setup checklist)', () => {
  const base: WorkspaceChecklist = {
    workspace_created: true,
    agent_created: true,
    agent_generated: true,
    agent_published: true,
    credits_purchased: true,
    number_attached: true,
    forwarding_tested: false,
    team_invited: false,
    onboarding_step: 7,
    complete: true,
    all_done: false,
  };
  it('lists the eight rows in order with where each is done', () => {
    const { rows, done, total } = checklistRows(base);
    expect(rows.map((r) => r.key)).toEqual(['workspace_created', 'agent_created', 'agent_generated', 'agent_published', 'credits_purchased', 'number_attached', 'forwarding_tested', 'team_invited']);
    expect(rows.at(-1)).toEqual({ key: 'team_invited', done: false, href: '/app/settings/?tab=team' });
    expect(rows[6]!.href).toBe('/app/numbers/');
    expect({ done, total }).toEqual({ done: 6, total: 8 });
  });
  it('leaves the forwarding row out when nothing forwards', () => {
    const { rows, total } = checklistRows({ ...base, forwarding_tested: null });
    expect(rows.some((r) => r.key === 'forwarding_tested')).toBe(false);
    expect(total).toBe(7);
  });
});
