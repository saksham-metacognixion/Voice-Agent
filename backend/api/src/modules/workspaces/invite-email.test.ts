import { describe, expect, it } from 'vitest';
import { fillSecrets } from '../notifications/notifications.service';
import { INVITE_LINK_PLACEHOLDER, inviteLink, renderInviteEmail } from './invite-email';

/*
 * D6 "Send invite" emails the link. The token exists only in the send and the inbox: the
 * rendered email (what the outbox stores) carries a placeholder, filled at send time.
 */
const email = renderInviteEmail({
  to: 'sam@example.test',
  inviter: 'Priya Shah',
  workspace: 'Maple Dental',
  role: 'editor',
  expiresAt: new Date('2026-11-02T15:00:00Z'),
  timezone: 'America/Toronto',
  replyTo: 'priya@mapledental.test',
});

describe('renderInviteEmail', () => {
  it('says who invited them, to which workspace, as what, and until when', () => {
    expect(email.to).toBe('sam@example.test');
    expect(email.subject).toBe('Priya Shah invited you to join Maple Dental');
    expect(email.text).toContain('Priya Shah invited you to join Maple Dental as Editor.');
    expect(email.text).toContain('with this email address (sam@example.test)');
    expect(email.text).toContain('expires on November 2, 2026');
    // Sent from the platform's address; a reply reaches the person who invited them.
    expect(email.replyTo).toBe('priya@mapledental.test');
  });

  it('carries the link as a placeholder, never a token', () => {
    expect(email.text).toContain(`Accept the invitation: ${INVITE_LINK_PLACEHOLDER}`);
    expect(email.text).not.toMatch(/token=/);
  });

  it('gets the real link only in the copy that is sent', () => {
    const link = inviteLink('https://app.oraly.ai', 'abc_DEF-123');
    const sent = fillSecrets(email, { invite_link: link });
    expect(sent.text).toContain('Accept the invitation: https://app.oraly.ai/invite/?token=abc_DEF-123');
    expect(email.text).toContain(INVITE_LINK_PLACEHOLDER);
    // Braces that are not a known secret are left alone.
    expect(fillSecrets({ ...email, text: 'Hi {name}' }, { invite_link: link }).text).toBe('Hi {name}');
  });
});
