import { Logger } from '@nestjs/common';
import { withTimeout } from '../../common/timeout';

/** One outbound email. Plain text always; HTML when a template has one. Never a token or a secret. */
export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Where an email goes. Resend in staging/prod; the log in dev, CI and tests. */
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
        body: JSON.stringify({ from: this.from, to: [email.to], subject: email.subject, text: email.text, ...(email.html ? { html: email.html } : {}) }),
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

export function createEmailSender(env: NodeJS.ProcessEnv = process.env): EmailSender {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  if (key && from) return new ResendEmailSender(key, from);
  return new LogEmailSender();
}

/** `s…m@example.com` — enough to recognise, not enough to harvest. */
export function maskEmail(address: string): string {
  const [local = '', domain = ''] = address.split('@');
  if (local.length <= 2) return `${local[0] ?? '*'}*@${domain}`;
  return `${local[0]}…${local[local.length - 1]}@${domain}`;
}
