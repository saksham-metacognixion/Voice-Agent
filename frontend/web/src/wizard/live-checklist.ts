import type { AgentWidget, MemberResponse, NotificationSettingsResponse, PhoneNumberResponse } from '@portal/schemas';

export type LiveChecklistKey = 'forwarding' | 'invite_team' | 'daily_digest' | 'website_widget';

export interface LiveChecklistItem {
  key: LiveChecklistKey;
  done: boolean;
}

export interface LiveChecklistFacts {
  number: Pick<PhoneNumberResponse, 'forwarding'> | null | undefined;
  members: Pick<MemberResponse, 'id'>[] | undefined;
  notifications: Pick<NotificationSettingsResponse, 'new_message'> | undefined;
  widget: Pick<AgentWidget, 'enabled'> | undefined;
}

/**
 * §8 W7b "Next-steps checklist: invite a teammate, turn on daily digest, add your
 * website widget", plus "forwarding tested" for an Option B number (the D1 checklist
 * names it). Every tick is read back from the rows the API holds, never from what the
 * browser remembers; a fact not loaded yet reads as not done. Forwarding is listed only
 * for a number the customer forwards to.
 */
export function liveChecklist(facts: LiveChecklistFacts): LiveChecklistItem[] {
  const forwarding = facts.number?.forwarding ?? null;
  const items: LiveChecklistItem[] = [];
  if (forwarding) items.push({ key: 'forwarding', done: forwarding.status === 'ready' || forwarding.test?.status === 'landed' });
  items.push({ key: 'invite_team', done: (facts.members?.length ?? 0) > 1 });
  items.push({ key: 'daily_digest', done: facts.notifications?.new_message === 'daily' });
  items.push({ key: 'website_widget', done: facts.widget?.enabled === true });
  return items;
}
