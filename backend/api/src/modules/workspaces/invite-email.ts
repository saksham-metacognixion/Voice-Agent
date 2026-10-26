import type { MemberRole } from '@portal/schemas';
import type { OutboundEmail } from '../notifications';

/**
 * The A8 invitation email (D6 "Send invite"). The link is a placeholder: the token exists
 * only in this send and in the invitee's inbox (A8 stores its hash), so the outbox row
 * keeps `{invite_link}` and `NotificationsService` fills it in for the provider alone.
 */
export const INVITE_LINK_PLACEHOLDER = '{invite_link}';

const ROLE_NAMES: Record<MemberRole, string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };

export interface InviteEmailInput {
  to: string;
  inviter: string;
  workspace: string;
  role: MemberRole;
  expiresAt: Date;
  /** The workspace's timezone, so "expires on" is the inviter's calendar day. */
  timezone: string;
  /** The inviter's own address: the email is sent from the platform's, and a reply reaches them. */
  replyTo?: string | null;
}

export function renderInviteEmail(input: InviteEmailInput): OutboundEmail {
  const expires = formatDay(input.expiresAt, input.timezone);
  const role = ROLE_NAMES[input.role];
  return {
    to: input.to,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    subject: `${input.inviter} invited you to join ${input.workspace}`,
    text: [
      'Hello,',
      '',
      `${input.inviter} invited you to join ${input.workspace} as ${role}.`,
      '',
      `Accept the invitation: ${INVITE_LINK_PLACEHOLDER}`,
      '',
      `Sign in, or create an account, with this email address (${input.to}) to accept. The link works once and expires on ${expires}.`,
      '',
      "If you weren't expecting this invitation, you can ignore this email.",
    ].join('\n'),
  };
}

/** The invite link, built on the one portal origin (`portalUrl()`), never by hand elsewhere. */
export function inviteLink(origin: string, token: string): string {
  return `${origin}/invite/?token=${encodeURIComponent(token)}`;
}

function formatDay(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: timezone }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(at);
  }
}
