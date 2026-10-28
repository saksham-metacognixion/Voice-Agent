import { describe, expect, it } from 'vitest';
import { NUMBER_COLUMNS, auditLine, csvLine, numberLine, versionJson, workspaceJson } from './export-sections';
import { deletionTicketBody } from './data-requests.service';

describe('data export sections (QA-081)', () => {
  it('guards formula-looking cells and quotes like the call export', () => {
    expect(csvLine(['=HYPERLINK("x")', '+14165550100', 'plain', 3, true, null])).toBe('"\t=HYPERLINK(""x"")","\t+14165550100",plain,3,true,\r\n');
  });

  it('names a number bought or sip, never its vendor, and writes one cell per column', () => {
    const base = {
      id: 'n1',
      e164: '+14165550100',
      nickname: null,
      country: 'CA',
      areaCode: '416',
      requestedAreaCode: '647',
      tollFree: false,
      status: 'active',
      agentId: null,
      hoursMode: 'always',
      hoursOverrideJson: null,
      transferTargetsJson: [{ label: 'Desk', number: '+14165550101' }],
      transferFailMessage: null,
      allowedCountries: ['CA', 'US'],
      blocklist: [],
      forwardingFrom: null,
      forwardingStatus: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      releasedAt: null,
    };
    const bought = numberLine({ ...base, type: 'retell_twilio' });
    expect(bought).not.toMatch(/retell|twilio|telnyx/i);
    expect(bought.split(',')[3]).toBe('bought');
    expect(numberLine({ ...base, type: 'custom_sip' }).split(',')[3]).toBe('sip');
    expect(NUMBER_COLUMNS[3]).toBe('kind');
    expect(bought).toContain('CA US');
  });

  it('keeps the card’s provider id out of workspace.json', () => {
    const json = workspaceJson({
      id: 'w',
      name: 'Maple',
      country: 'CA',
      timezone: 'America/Toronto',
      addressJson: null,
      website: null,
      planTier: 'growth',
      concurrencyCap: 3,
      kbAllowance: 1,
      businessHoursJson: null,
      autoTopupJson: { enabled: true, pack_id: 'growth', threshold: 50, payment_method_id: 'pm_123', card_last4: '4242' },
      recordingDefault: true,
      retentionDays: 90,
      onboardingCompletedAt: null,
      pausedAt: null,
      kycStatus: 'none',
      createdAt: new Date('2026-10-01T00:00:00Z'),
    });
    expect(json.auto_topup).toEqual({ enabled: true, pack_id: 'growth', threshold: 50 });
    expect(JSON.stringify(json)).not.toContain('pm_123');
  });

  it('writes a version’s brief, settings and script under customer names', () => {
    const v = versionJson({
      agentId: 'a',
      versionNo: 2,
      source: 'generated',
      briefJson: { business_name: 'Maple' },
      settingsJson: { tier: 'standard' },
      promptText: 'You are…',
      greeting: 'Hi',
      closing: 'Bye',
      analysisSchemaJson: null,
      feedbackText: null,
      publishedAt: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    });
    expect(Object.keys(v)).toEqual(['agent_id', 'version_no', 'source', 'brief', 'settings', 'prompt', 'greeting', 'closing', 'analysis_fields', 'feedback', 'published_at', 'created_at']);
  });

  it('writes the audit meta as JSON text', () => {
    const line = auditLine({ id: 'e', createdAt: new Date('2026-10-01T00:00:00Z'), action: 'agent.published', actorUserId: 'u', actor: { email: 'o@example.test' }, targetType: 'agent', targetId: 'a', ip: null, metaJson: { version: 2 } });
    expect(line).toBe('e,2026-10-01T00:00:00.000Z,agent.published,u,o@example.test,agent,a,,"{""version"":2}"\r\n');
  });

  it('tells staff and the customer what the deletion means, and by when', () => {
    const body = deletionTicketBody('Maple Dental', new Date('2026-11-27T12:00:00Z'));
    expect(body).toContain('“Maple Dental”');
    expect(body).toContain('2026-11-27');
    expect(body).toMatch(/releases every phone number/);
    expect(body).toMatch(/forfeits any remaining credits/);
  });
});
