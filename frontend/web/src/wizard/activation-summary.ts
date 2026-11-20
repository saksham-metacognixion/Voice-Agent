import type { AgentDetail, PhonePlanResponse } from '@portal/schemas';

/** Where a summary row's "Change" link goes: the wizard step that owns the fact. */
export type SummaryEdit = 'brief' | 'voice' | 'phone';

export interface SummaryRow {
  key: 'agent' | 'voice' | 'languages' | 'number' | 'answering' | 'forwarding' | 'documents' | 'knowledge' | 'tested';
  /** Which `wizard.w7.summary.values.*` line says it, with its placeholders. */
  value: { id: string; values?: Record<string, string | number> };
  edit: SummaryEdit | null;
}

export interface SummaryFacts {
  agent: Pick<AgentDetail, 'name' | 'draft' | 'tier'>;
  plan: PhonePlanResponse | null;
  /** The draft's voice, by name, once the voice list answered; null while unknown or unset. */
  voiceName: string | null;
  /** `GET /calls?is_test=true` → `total`; null while unknown. */
  testCalls: number | null;
  rentalCredits: number | null;
}

/**
 * §8 W7 "Summary card … with Change links back to W3/W6": every row is a fact the
 * wizard saved, read back from the agent's draft and the pending phone plan, never from
 * what this page remembers. The rows are ids and placeholders so the component can
 * speak the portal's language; a fact that is not known yet is a row that says so.
 */
export function summaryRows(facts: SummaryFacts): SummaryRow[] {
  const settings = facts.agent.draft?.settings ?? null;
  const brief = facts.agent.draft?.brief ?? null;
  const tier = settings?.tier ?? facts.agent.tier;
  const rows: SummaryRow[] = [];

  rows.push({ key: 'agent', value: { id: `agent.${tier}`, values: { name: brief?.agent_name?.trim() || facts.agent.name } }, edit: 'brief' });
  rows.push({ key: 'voice', value: facts.voiceName ? { id: 'voice', values: { name: facts.voiceName } } : { id: 'voiceUnknown' }, edit: 'voice' });
  const languages = settings ? [settings.primary_language, ...settings.languages] : [];
  rows.push({ key: 'languages', value: languages.length ? { id: 'languages', values: { list: languages.join(', ') } } : { id: 'languagesUnknown' }, edit: 'voice' });

  const plan = facts.plan;
  if (!plan) rows.push({ key: 'number', value: { id: 'noPlan' }, edit: 'phone' });
  else if (plan.option === 'sip') rows.push({ key: 'number', value: { id: 'sip', values: { number: plan.sip?.number ?? '', host: plan.sip?.host ?? '' } }, edit: 'phone' });
  else {
    const area = plan.toll_free ? 'tollFree' : plan.area_code ? 'areaCode' : 'anyArea';
    const base = { country: plan.country ?? '', code: plan.area_code ?? '', rental: facts.rentalCredits ?? 0 };
    rows.push({ key: 'number', value: { id: `${plan.option === 'forward' ? 'forward' : 'new'}.${area}`, values: plan.option === 'forward' ? { ...base, from: plan.existing_number ?? '' } : base }, edit: 'phone' });
  }
  rows.push({ key: 'answering', value: { id: `answering.${plan?.hours_mode ?? 'always'}` }, edit: 'phone' });
  if (plan?.option === 'forward') rows.push({ key: 'forwarding', value: { id: `forwarding.${plan.forward_mode ?? 'always'}` }, edit: 'phone' });

  const documents = brief?.documents.length ?? 0;
  rows.push({ key: 'documents', value: documents ? { id: 'documents', values: { n: documents } } : { id: 'noDocuments' }, edit: 'brief' });
  rows.push({ key: 'knowledge', value: { id: 'knowledgeLater' }, edit: null });
  rows.push({ key: 'tested', value: facts.testCalls === null ? { id: 'testedUnknown' } : facts.testCalls > 0 ? { id: 'tested', values: { n: facts.testCalls } } : { id: 'untested' }, edit: null });
  return rows;
}
