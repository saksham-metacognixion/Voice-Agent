import { describe, expect, it } from 'vitest';
import { isImageDocumentType } from './agents.js';
import { workspaceNameMatches } from './data-requests.js';
import { isRestaurantAgent, knowledgeRolesFor } from './knowledge.js';
import { signInMethodOf } from './security.js';
import { normaliseWidgetOrigin } from './widget.js';
import { inviteStatusAt } from './workspaces.js';

/* Pure rules the API and the portal share, so the two cannot disagree. */

describe('inviteStatusAt (D11, BUG-010)', () => {
  const now = new Date('2026-11-04T12:00:00Z');

  it('pending up to and including expires_at, expired one millisecond after', () => {
    expect(inviteStatusAt({ expires_at: '2026-11-04T12:00:00Z', accepted_at: null }, now)).toBe('pending');
    expect(inviteStatusAt({ expires_at: new Date(now.getTime() - 1), accepted_at: null }, now)).toBe('expired');
  });

  it('accepted wins over expired: it was used in time', () => {
    expect(inviteStatusAt({ expires_at: '2026-10-01T00:00:00Z', accepted_at: '2026-09-30T00:00:00Z' }, now)).toBe('accepted');
  });
});

describe('workspaceNameMatches (ADR 0032 §6 delete request)', () => {
  it.each([
    ['Acme Dental', 'Acme Dental', true],
    ['acmedental', 'Acme Dental', true],
    ['  ACME   dental ', 'Acme Dental', true],
    ['Acme Dent', 'Acme Dental', false],
    ['Acme Dental Clinic', 'Acme Dental', false],
    ['', 'Acme Dental', false],
  ])('%j against %j → %s', (typed, name, expected) => {
    expect(workspaceNameMatches(typed, name)).toBe(expected);
  });

  it('a blank workspace name never matches, not even a blank confirmation', () => {
    expect(workspaceNameMatches('', '')).toBe(false);
    expect(workspaceNameMatches('   ', '  ')).toBe(false);
  });
});

describe('normaliseWidgetOrigin (D17 allow-list)', () => {
  it.each([
    ['https://Example.com/contact?x=1', 'https://example.com'],
    ['example.com', 'https://example.com'],
    ['shop.example.co.uk', 'https://shop.example.co.uk'],
    ['https://example.com:8443', 'https://example.com:8443'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://127.0.0.1:5173/page', 'http://127.0.0.1:5173'],
  ])('%j → %j', (value, expected) => {
    expect(normaliseWidgetOrigin(value)).toBe(expected);
  });

  it.each([
    'http://example.com',
    'ftp://example.com',
    'javascript:alert(1)',
    'https://user:pass@example.com',
    'https://intranet',
    'not a url',
    '',
  ])('%j is refused', (value) => {
    expect(normaliseWidgetOrigin(value)).toBeNull();
  });

  it('a name that only starts with "localhost" is an ordinary https site, not the http exception', () => {
    expect(normaliseWidgetOrigin('https://localhost.example.com')).toBe('https://localhost.example.com');
    expect(normaliseWidgetOrigin('http://localhost.example.com')).toBeNull();
  });

  it('an IP origin is accepted: the list is only compared with the browser Origin, never fetched', () => {
    expect(normaliseWidgetOrigin('https://203.0.113.7')).toBe('https://203.0.113.7');
  });
});

describe('signInMethodOf (D6 Security)', () => {
  it.each([
    ['auth0', 'password'],
    ['google-oauth2', 'google'],
    ['windowslive', 'microsoft'],
    ['waad', 'microsoft'],
    ['github', 'other'],
    ['', 'other'],
  ])('%j → %s', (provider, expected) => {
    expect(signInMethodOf(provider)).toBe(expected);
  });
});

describe('isRestaurantAgent / knowledgeRolesFor (ADR 0020)', () => {
  it.each([
    [{ template_id: 'restaurant', industry: null }, true],
    [{ template_id: 'custom', industry: ' Restaurant ' }, true],
    [{ template_id: 'receptionist', industry: 'dental' }, false],
    [{ template_id: null, industry: null }, false],
  ])('%j → restaurant=%s', (agent, expected) => {
    expect(isRestaurantAgent(agent)).toBe(expected);
    expect(knowledgeRolesFor(agent)).toEqual(expected ? ['menu'] : []);
  });
});

describe('isImageDocumentType (ADR 0023 photos)', () => {
  it.each([
    ['image/jpeg', true],
    ['image/png', true],
    ['image/webp', true],
    ['image/gif', false],
    ['application/pdf', false],
    ['IMAGE/PNG', false],
  ])('%s → %s', (type, expected) => {
    expect(isImageDocumentType(type)).toBe(expected);
  });
});
