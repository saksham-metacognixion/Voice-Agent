import { memberRole, planTier, reasonCode } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import ar from '../i18n/messages/ar.json';
import en from '../i18n/messages/en.json';
import frCA from '../i18n/messages/fr-CA.json';
import { AUDIT_AREAS, KNOWN_AUDIT_ACTIONS, KNOWN_AUDIT_META, auditActionKey, auditActorKind, auditMetaPairs, humaniseAction, valueKey } from './audit-view';

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

describe('what the support team does (QA-032)', () => {
  const audit = en.dashboard.settings.audit as unknown as { areas: Record<string, string>; actions: Record<string, string>; meta: Record<string, string>; reasons: Record<string, string> };

  it('names the staff-written actions and lets the area filter find them', () => {
    for (const action of ['credits.adjusted', 'purchase.refunded', 'workspace.paused', 'number.resumed', 'user.force_logout']) {
      expect(auditActionKey(action)).toBe(action.replace('.', '_'));
    }
    expect(AUDIT_AREAS).toEqual(expect.arrayContaining(['credits', 'purchase', 'user', 'support']));
  });

  it('has a line in the message file for every area, action and meta key it knows', () => {
    for (const area of AUDIT_AREAS) expect(audit.areas[area], area).toBeTruthy();
    for (const action of KNOWN_AUDIT_ACTIONS) expect(audit.actions[action.replace('.', '_')], action).toBeTruthy();
    for (const key of KNOWN_AUDIT_META) expect(audit.meta[key], key).toBeTruthy();
  });

  it('shows a role change from → to, worded through the role names', () => {
    expect(auditMetaPairs({ from: 'editor', to: 'admin' })).toEqual([
      { key: 'from', value: 'editor', valueKey: 'shell.role.editor' },
      { key: 'to', value: 'admin', valueKey: 'shell.role.admin' },
    ]);
  });

  it('shows the auto top-up settings and a staff write’s reason and credits', () => {
    expect(auditMetaPairs({ pack_id: 'growth', threshold: 50, card_last4: '4242', by: 'staff' })).toEqual([
      { key: 'pack_id', value: 'growth', valueKey: 'shell.tier.growth' },
      { key: 'threshold', value: '50' },
      { key: 'card_last4', value: '4242' },
    ]);
    const pairs = auditMetaPairs({ by: 'staff', delta: -12.5, reason_code: 'goodwill', text: 'Sorry about Tuesday' });
    expect(pairs).toEqual([
      { key: 'delta', value: '-12.5' },
      { key: 'reason_code', value: 'goodwill', valueKey: 'dashboard.settings.audit.reasons.goodwill' },
      { key: 'text', value: 'Sorry about Tuesday' },
    ]);
    expect(audit.reasons.goodwill).toBeTruthy();
    // An id nobody words is shown as it is rather than as a missing key.
    expect(auditMetaPairs({ reason_code: 'brand_new' })).toEqual([{ key: 'reason_code', value: 'brand_new' }]);
  });

  it('says "Support team" for a staff write and the platform for the rest', () => {
    expect(auditActorKind({ actor: null, meta: { by: 'staff', reason_code: 'goodwill' } })).toBe('staff');
    expect(auditActorKind({ actor: null, meta: { e164: '+14165550100' } })).toBe('system');
    expect(auditActorKind({ actor: null, meta: null })).toBe('system');
    expect(auditActorKind({ actor: { name: 'Sam' }, meta: { by: 'staff' } })).toBe('member');
  });
});

describe('valueKey', () => {
  // Built at runtime, so the catalogue check cannot see these keys (QA-070: `common.role.viewer`).
  const resolve = (messages: unknown, key: string) => key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), messages);
  const keys = [
    ...memberRole.options.flatMap((r) => ['role', 'from', 'to'].map((k) => valueKey(k, r))),
    ...planTier.options.map((t) => valueKey('pack_id', t)),
    ...reasonCode.options.map((r) => valueKey('reason_code', r)),
  ];

  it.each([
    ['en', en],
    ['ar', ar],
    ['fr-CA', frCA],
  ])('resolves every key it can build in %s', (_, messages) => {
    for (const key of keys) {
      expect(key).not.toBeNull();
      expect(typeof resolve(messages, key as string), key as string).toBe('string');
    }
  });
});
