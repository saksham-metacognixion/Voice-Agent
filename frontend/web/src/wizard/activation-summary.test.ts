import { agentDetail, defaultAgentSettings, type AgentDetail, type PhonePlanResponse } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { summaryRows } from './activation-summary';

const agent = (over: Partial<AgentDetail['draft'] & object> = {}): AgentDetail['draft'] =>
  ({
    version_no: 2,
    source: 'generated',
    has_prompt: true,
    brief: { services: [], faqs: [], never_do_presets: [], handoff_rules: [], ai_disclosure: 'if_asked', documents: [], agent_name: 'Sophie' },
    settings: { ...defaultAgentSettings('standard'), primary_language: 'en-CA', languages: ['fr-CA'], voice_id: 'v1' },
    scenarios: [],
    changes: [],
    analysis_fields: [],
    created_at: '2026-11-06T00:00:00Z',
    ...over,
  }) as unknown as AgentDetail['draft'];

const plan = (over: Partial<PhonePlanResponse> = {}): PhonePlanResponse => ({
  id: 'p',
  agent_id: 'a',
  option: 'new',
  country: 'CA',
  area_code: '450',
  toll_free: false,
  existing_number: null,
  carrier: null,
  forward_mode: null,
  sip: null,
  hours_mode: 'outside_hours',
  transfer_targets: [],
  allowed_countries: ['CA', 'US'],
  status: 'pending',
  number_id: null,
  created_at: '2026-11-06T00:00:00Z',
  updated_at: '2026-11-06T00:00:00Z',
  ...over,
});

const facts = { agent: { name: 'Receptionist', tier: 'standard' as const, draft: agent() }, voiceName: 'Sophie', testCalls: 3, rentalCredits: 15 };

describe('summaryRows', () => {
  it('reads every fact from the draft and the plan, with the step that owns it', () => {
    const rows = summaryRows({ ...facts, plan: plan() });
    expect(rows.map((r) => [r.key, r.value.id, r.edit])).toEqual([
      ['agent', 'agent.standard', 'brief'],
      ['voice', 'voice', 'voice'],
      ['languages', 'languages', 'voice'],
      ['number', 'new.areaCode', 'phone'],
      ['answering', 'answering.outside_hours', 'phone'],
      ['documents', 'noDocuments', 'brief'],
      ['knowledge', 'knowledgeLater', null],
      ['tested', 'tested', null],
    ]);
    expect(rows[0]?.value.values).toEqual({ name: 'Sophie' });
    expect(rows[2]?.value.values).toEqual({ list: 'en-CA, fr-CA' });
    expect(rows[3]?.value.values).toEqual({ country: 'CA', code: '450', rental: 15 });
    expect(rows[7]?.value.values).toEqual({ n: 3 });
  });

  it('describes a forwarded line with its mode, a SIP trunk by its host, a toll-free number as such', () => {
    const fwd = summaryRows({ ...facts, plan: plan({ option: 'forward', existing_number: '+14505550199', forward_mode: 'busy_no_answer' }) });
    expect(fwd.find((r) => r.key === 'number')?.value).toEqual({ id: 'forward.areaCode', values: { country: 'CA', code: '450', rental: 15, from: '+14505550199' } });
    expect(fwd.find((r) => r.key === 'forwarding')?.value.id).toBe('forwarding.busy_no_answer');
    const sip = summaryRows({ ...facts, plan: plan({ option: 'sip', sip: { number: '+14505550123', host: 'sip.example.com', username: null, has_password: false, provider: 'twilio', transport: 'TCP' } }) });
    expect(sip.find((r) => r.key === 'number')?.value).toEqual({ id: 'sip', values: { number: '+14505550123', host: 'sip.example.com' } });
    expect(sip.some((r) => r.key === 'forwarding')).toBe(false);
    expect(summaryRows({ ...facts, plan: plan({ toll_free: true, area_code: null }) }).find((r) => r.key === 'number')?.value.id).toBe('new.tollFree');
  });

  it('says what is not known rather than guessing', () => {
    const rows = summaryRows({ agent: { name: 'Receptionist', tier: 'premium', draft: agent({ settings: { ...defaultAgentSettings('premium'), voice_id: null } }) }, plan: null, voiceName: null, testCalls: null, rentalCredits: null });
    expect(rows.find((r) => r.key === 'agent')?.value).toEqual({ id: 'agent.premium', values: { name: 'Sophie' } });
    expect(rows.find((r) => r.key === 'voice')?.value.id).toBe('voiceUnknown');
    expect(rows.find((r) => r.key === 'number')?.value.id).toBe('noPlan');
    expect(rows.find((r) => r.key === 'tested')?.value.id).toBe('testedUnknown');
    expect(summaryRows({ ...facts, plan: plan(), testCalls: 0 }).find((r) => r.key === 'tested')?.value.id).toBe('untested');
  });

  it('counts the brief’s documents and falls back to the agent’s own name', () => {
    const d = agent({ brief: { services: [], faqs: [], never_do_presets: [], handoff_rules: [], ai_disclosure: 'if_asked', documents: [{ name: 'menu.pdf', text: 'x', content_type: 'application/pdf', truncated: false }] } });
    const rows = summaryRows({ ...facts, agent: { name: 'Receptionist', tier: 'standard', draft: d }, plan: plan() });
    expect(rows.find((r) => r.key === 'documents')?.value).toEqual({ id: 'documents', values: { n: 1 } });
    expect(rows.find((r) => r.key === 'agent')?.value.values).toEqual({ name: 'Receptionist' });
  });

  it('parses against the real agent schema shape it reads', () => {
    expect(agentDetail.shape.draft).toBeDefined();
  });
});
