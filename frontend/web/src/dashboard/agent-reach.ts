import type { AgentSummary } from '@portal/schemas';

/**
 * A published agent nobody can ring. The wizard buys the number at activation (W6, W7);
 * "+ New agent" and "Duplicate" skip both, and a publish adds none, so `status = live`
 * alone says nothing about the phone. A number still being set up counts as attached,
 * and a released one has left the agent. Draft and paused agents keep their own badge.
 */
export function agentNeedsNumber(agent: Pick<AgentSummary, 'status' | 'numbers_attached'>): boolean {
  return agent.status === 'live' && agent.numbers_attached === 0;
}
