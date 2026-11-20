import { Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { withTimeout } from '../../common/timeout';

/** One outbound email. Plain text always; HTML when a template has one. Never a token or a secret. */
export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * Where a reply goes — the person behind the message (the inviter), never the shared
   * sender address. Every email is sent *from* the platform's one address; this is how a
   * reply to "Priya invited you" reaches Priya.
   */
  replyTo?: string;
}

/** Where an email goes. Resend or SMTP when configured; the log in dev, CI and tests. */
export interface EmailSender {
  readonly name: string;
  /** Resolves with the provider's message id (or a synthetic one). Throws on a delivery failure. */
  send(email: OutboundEmail): Promise<{ id: string }>;
}

/** Budget for one provider call. A slow email provider must never hold up a schedule tick. */
export const EMAIL_TIMEOUT_MS = 5_000;

/**
 * Resend's REST API over `fetch`, no SDK: one endpoint, one header, and nothing else from
 * the package would be used. `RESEND_API_KEY` is read once here and never logged.
 */
export class ResendEmailSender implements EmailSender {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly endpoint = 'https://api.resend.com/emails',
  ) {}

  async send(email: OutboundEmail): Promise<{ id: string }> {
    // The signal reaches fetch, so a provider that hangs is cancelled, not left dangling.
    return withTimeout(EMAIL_TIMEOUT_MS, async (signal) => {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: this.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          ...(email.html ? { html: email.html } : {}),
          ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        }),
        signal,
      });
      if (!response.ok) {
        // The body may quote our request back; log the status only.
        throw new Error(`resend answered ${response.status}`);
      }
      const body = (await response.json().catch(() => ({}))) as { id?: string };
      return { id: body.id ?? `resend_${Date.now()}` };
    });
  }
}

/** SMTP needs a TCP connect, TLS and an AUTH round trip before the message; 5 s is Resend's budget, not this one's. */
export const SMTP_TIMEOUT_MS = 15_000;

/** The slice of a nodemailer transport this sender uses — what a test substitutes. */
export interface SmtpTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string; html?: string; replyTo?: string }): Promise<{ messageId?: string }>;
}

/**
 * Plain SMTP (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`) for a box without Resend —
 * a Gmail app password on a dev machine, or any provider's SMTP relay. STARTTLS on 587,
 * implicit TLS on 465. The password is read here, handed to the transport and never
 * logged. One pooled connection, so an invite after the first does not pay the
 * handshake again.
 *
 * Gmail sends only as the account it authenticates (it rewrites any other From), so
 * `EMAIL_FROM` there is the account's own address with a display name.
 */
export class SmtpEmailSender implements EmailSender {
  readonly name = 'smtp';

  constructor(
    private readonly transport: SmtpTransport,
    private readonly from: string,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv): SmtpEmailSender | null {
    const host = env.SMTP_HOST?.trim();
    const user = env.SMTP_USER?.trim();
    const pass = env.SMTP_PASS?.trim();
    if (!host || !user || !pass) return null;
    const port = Number(env.SMTP_PORT?.trim() || 587);
    const transport = createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: { user, pass },
      pool: true,
      maxConnections: 2,
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
    return new SmtpEmailSender(transport, env.EMAIL_FROM?.trim() || user);
  }

  async send(email: OutboundEmail): Promise<{ id: string }> {
    return withTimeout(SMTP_TIMEOUT_MS, async () => {
      try {
        const info = await this.transport.sendMail({
          from: this.from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          ...(email.html ? { html: email.html } : {}),
          ...(email.replyTo ? { replyTo: email.replyTo } : {}),
        });
        return { id: info.messageId ?? `smtp_${Date.now()}` };
      } catch (error) {
        // The server's answer can echo the envelope; keep the code, drop the rest.
        const code = (error as { responseCode?: number; code?: string }).responseCode ?? (error as { code?: string }).code ?? 'error';
        throw new Error(`smtp send failed: ${code}`);
      }
    });
  }
}

/**
 * The sender that always exists: one log line per message — recipient and subject, never
 * the body, so a digest that lists callers' numbers does not end up in a log aggregator.
 */
export class LogEmailSender implements EmailSender {
  readonly name = 'log';
  private readonly log = new Logger('Email');
  /** Everything "sent", for tests. */
  readonly sent: OutboundEmail[] = [];

  async send(email: OutboundEmail): Promise<{ id: string }> {
    this.sent.push(email);
    this.log.log(`email (not delivered: no RESEND_API_KEY) to ${maskEmail(email.to)}: "${email.subject}"`);
    return { id: `log_${Date.now()}_${this.sent.length}` };
  }
}

/** Resend when it has a key, else SMTP when it has a host and a login, else the log. */
export function createEmailSender(env: NodeJS.ProcessEnv = process.env): EmailSender {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (key && from) return new ResendEmailSender(key, from);
  return SmtpEmailSender.fromEnv(env) ?? new LogEmailSender();
}

/** `s…m@example.com` — enough to recognise, not enough to harvest. */
export function maskEmail(address: string): string {
  const [local = '', domain = ''] = address.split('@');
  if (local.length <= 2) return `${local[0] ?? '*'}*@${domain}`;
  return `${local[0]}…${local[local.length - 1]}@${domain}`;
}
