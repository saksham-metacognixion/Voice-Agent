import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { resolveAppEnv } from '../../common/env';

export type WebhookProvider = 'retell' | 'stripe' | 'auth';

export interface CapturedWebhook {
  provider: WebhookProvider;
  /** `call_ended`, `checkout.session.completed`, … — becomes part of the filename. */
  eventType: string;
  /** Route path including params, so `number_token` survives into the fixture. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Exact bytes as received. Kept so D3's signature tests run against real input. */
  raw: Buffer | undefined;
  body: unknown;
  /** Result of the provider signature check against `raw`, when one was run. */
  signatureValid?: boolean;
  /** What we answered, for webhooks whose response changes provider behaviour. */
  response?: unknown;
}

/** Headers that carry a secret rather than something a test needs. */
const REDACTED_HEADERS = new Set(['authorization', 'cookie', 'x-auth0-secret']);

/**
 * Writes every webhook that reaches the API to disk as a fixture.
 *
 * This exists for D2: the §21 questions (call_cost shape, decline mechanism,
 * max_call_duration_ms) are answered by reading real payloads, and D3's metering and
 * exactly-once tests are written against those files rather than against guesses. The
 * D2 exit check is literally "fixtures committed".
 *
 * Deliberately dumb. No parsing beyond the event type, no DB, no queue, and it can never
 * fail a request — a write error is logged and swallowed, because a provider retrying a
 * webhook over a full disk helps nobody.
 *
 * Hard-off outside dev/staging. There is no configuration that makes it write in prod.
 *
 * The §13.9 inbound route is the exception: it is the one endpoint with a latency SLO and
 * the one that can arrive thousands of times a minute, so capture there is **opt-in**
 * (`CAPTURE_INBOUND_FIXTURES=true`) rather than on by default. A k6 run against a dev API
 * with it on writes one file per request — 52 000 of them in a 30-second run, which is how
 * this rule was learned.
 */
@Injectable()
export class FixtureWriter {
  private readonly log = new Logger(FixtureWriter.name);
  readonly enabled: boolean;
  /** Capture on the inbound hot path. Off unless asked for explicitly; see the class note. */
  readonly enabledOnHotPath: boolean;
  readonly directory: string;

  constructor() {
    const env = resolveAppEnv();
    const optedOut = process.env.CAPTURE_FIXTURES === 'false';
    // `resolveAppEnv` reads an unset or unrecognised APP_ENV as prod, so "hard-off
    // outside dev/staging" holds even in a container that dropped the variable.
    this.enabled = env !== 'prod' && !optedOut;
    this.enabledOnHotPath = this.enabled && process.env.CAPTURE_INBOUND_FIXTURES === 'true';
    this.directory = path.resolve(process.cwd(), process.env.FIXTURE_DIR ?? 'test/fixtures');

    if (this.enabled) {
      this.log.log(`capturing webhook fixtures to ${this.directory}${this.enabledOnHotPath ? ' (including the inbound hot path)' : ''}`);
    } else {
      this.log.log(`fixture capture off (APP_ENV=${env}, CAPTURE_FIXTURES=${process.env.CAPTURE_FIXTURES ?? 'unset'})`);
    }
  }

  /**
   * Capture for the §13.9 inbound route. A separate method, not a flag on `capture()`, so
   * the hot path cannot be switched on by the same variable that turns on ordinary
   * capture — and so this call site is greppable.
   */
  async captureInbound(hook: CapturedWebhook): Promise<string | undefined> {
    if (!this.enabledOnHotPath) return undefined;
    return this.capture(hook);
  }

  /** Resolves to the written path, or undefined when disabled or the write failed. */
  async capture(hook: CapturedWebhook): Promise<string | undefined> {
    if (!this.enabled) return undefined;

    const dir = path.join(this.directory, hook.provider);
    const file = path.join(dir, `${safeName(hook.eventType)}-${timestamp()}.json`);

    const record = {
      captured_at: new Date().toISOString(),
      provider: hook.provider,
      event_type: hook.eventType,
      path: hook.path,
      headers: redact(hook.headers),
      raw: hook.raw?.toString('utf8'),
      body: hook.body,
      ...(hook.signatureValid === undefined ? {} : { signature_valid: hook.signatureValid }),
      ...(hook.response === undefined ? {} : { response: hook.response }),
    };

    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
      this.log.log(`${hook.provider} ${hook.eventType} (${hook.raw?.length ?? 0} B) → ${path.relative(process.cwd(), file)}`);
      return file;
    } catch (error) {
      this.log.error(`could not write fixture for ${hook.provider} ${hook.eventType}: ${String(error)}`);
      return undefined;
    }
  }
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/** `2026-09-15T09-41-22.318Z` — sortable, and legal on every filesystem. */
function timestamp(): string {
  return new Date().toISOString().replace(/:/g, '-');
}

function redact(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? '[redacted]' : value;
  }
  return out;
}
