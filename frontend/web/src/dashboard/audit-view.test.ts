import { describe, expect, it } from 'vitest';
import { auditActionKey, auditMetaPairs, humaniseAction } from './audit-view';

describe('audit actions', () => {
  it('names the actions the message file knows', () => {
    expect(auditActionKey('agent.published')).toBe('agent_published');
    expect(auditActionKey('phone_plan.created')).toBe('phone_plan_created');
    expect(auditActionKey('workspace.ownership_transferred')).toBe('workspace_ownership_transferred');
    expect(auditActionKey('something.new')).toBeNull();
  });

  it('falls back to a readable form for the rest', () => {
    expect(humaniseAction('number.release_requested')).toBe('Number · release requested');
    expect(humaniseAction('phone_plan.created')).toBe('Phone plan · created');
    expect(humaniseAction('orphan')).toBe('Orphan');
  });
});

describe('auditMetaPairs', () => {
  it('keeps known flat facts, shortens ids, leaves booleans for the table to word and drops the rest', () => {
    expect(
      auditMetaPairs({ agent_id: '0b7a3c1e-1111-2222-3333-444455556666', has_password: false, fields: ['nickname', 'paused'], nested: { a: 1 }, empty: null, version_no: 3 }),
    ).toEqual([
      { key: 'agent_id', value: '0b7a3c1e…' },
      { key: 'has_password', value: false },
      { key: 'fields', value: 'nickname, paused' },
      { key: 'version_no', value: '3' },
    ]);
    expect(auditMetaPairs(null)).toEqual([]);
  });

  it('never shows a key the message file does not label — provider details stay server-side', () => {
    expect(auditMetaPairs({ retell_cleanup_errors: ['x'], retell_agent_version: 4, platform_copy: false, config_version: 2, name: 'Front desk' })).toEqual([{ key: 'name', value: 'Front desk' }]);
  });
});
