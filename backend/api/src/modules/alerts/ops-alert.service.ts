import { Injectable, Logger } from '@nestjs/common';

/**
 * One operations alert: what a human on call needs to start looking, and nothing that
 * would hurt if the channel leaked. `fields` is free-form but every value passes
 * through `redact()` before it leaves the process.
 */
export interface OpsAlert {
  /** Stable machine name, e.g. `activation_failed`, `auto_topup_failed`. */
  kind: string;
  severity: 'warning' | 'critical';
  title: string;
  fields: Record<string, string | number | boolean | null | undefined>;
  /** Defaults to now. */
  at?: Date;
}

/** Everything an alert sink must do. The default posts to Slack; tests capture. */
export interface OpsAlertSink {
  readonly name: string;
  deliver(alert: OpsAlert, text: string): Promise<void>;
}

/** Budget for one delivery. An alert must never hold up the job that raised it. */
const DELIVER_TIMEOUT_MS = 3_000;

/**
 * Key names whose *values* are never written anywhere, whatever a caller passes. Matched
 * case-insensitively on the field name.
 */
const SECRET_KEY_RE = /(password|secret|token|api[_-]?key|authorization|credential|private)/i;
/** Values that look like credentials even under an innocent name. */
const SECRET_VALUE_RES = [
  /^(sk|rk|whsec|pk)_(live|test)_[A-Za-z0-9]{8,}/, // Stripe
  /^key_[0-9a-f]{16,}/i, // Retell
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^Bearer\s+\S+/i,
];

/**
 * Operations alerts (§13.12 "Slack alerts"). The smallest thing that satisfies "tell a
 * human when something needs one": a structured log line always, plus a webhook post
 * when `OPS_ALERT_WEBHOOK_URL` is set (a Slack incoming webhook in staging and prod).
 *
 * Never throws and never waits past its budget: a Slack outage must not turn an already
 * failed activation into a stuck job.
 */
@Injectable()
export class OpsAlertService {
  private readonly log = new Logger(OpsAlertService.name);
  private readonly sinks: OpsAlertSink[] = [];
  /** Alerts raised in this process, newest last — for tests and the health page. */
  readonly recent: Array<OpsAlert & { text: string }> = [];

  constructor(sink?: OpsAlertSink | null) {
    if (sink) this.sinks.push(sink);
  }

  addSink(sink: OpsAlertSink): void {
    this.sinks.push(sink);
  }

  async send(alert: OpsAlert): Promise<void> {
    const safe = redactAlert(alert);
    const text = formatAlert(safe);
    this.recent.push({ ...safe, text });
    if (this.recent.length > 50) this.recent.shift();

    // The log line is the sink that always exists.
    if (safe.severity === 'critical') this.log.error(text);
    else this.log.warn(text);

    await Promise.all(
      this.sinks.map(async (sink) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            sink.deliver(safe, text),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`timed out after ${DELIVER_TIMEOUT_MS} ms`)), DELIVER_TIMEOUT_MS);
            }),
          ]);
        } catch (error) {
          this.log.warn(`ops alert sink ${sink.name} failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
  }
}

/** Posts the formatted text to a webhook (Slack incoming webhook shape: `{text}`). */
export class WebhookAlertSink implements OpsAlertSink {
  readonly name = 'webhook';
  constructor(private readonly url: string) {}

  async deliver(_alert: OpsAlert, text: string): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error(`webhook answered ${response.status}`);
  }
}

export function createOpsAlertService(env: NodeJS.ProcessEnv = process.env): OpsAlertService {
  const url = env.OPS_ALERT_WEBHOOK_URL?.trim();
  return new OpsAlertService(url ? new WebhookAlertSink(url) : null);
}

/** Drops secret-looking fields and truncates the rest. Pure, exported for the unit test. */
export function redactAlert(alert: OpsAlert): OpsAlert {
  const fields: OpsAlert['fields'] = {};
  for (const [key, value] of Object.entries(alert.fields)) {
    if (value === undefined) continue;
    if (SECRET_KEY_RE.test(key)) {
      fields[key] = '[redacted]';
      continue;
    }
    if (typeof value === 'string') {
      fields[key] = SECRET_VALUE_RES.some((re) => re.test(value.trim())) ? '[redacted]' : value.slice(0, 500);
      continue;
    }
    fields[key] = value;
  }
  return { ...alert, fields, at: alert.at ?? new Date() };
}

export function formatAlert(alert: OpsAlert): string {
  const at = (alert.at ?? new Date()).toISOString();
  const lines = [`[${alert.severity.toUpperCase()}] ${alert.kind}: ${alert.title}`];
  for (const [key, value] of Object.entries(alert.fields)) lines.push(`  ${key}: ${value === null ? 'null' : String(value)}`);
  lines.push(`  at: ${at}`);
  return lines.join('\n');
}
