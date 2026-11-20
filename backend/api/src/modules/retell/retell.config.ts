import { Logger } from '@nestjs/common';
import { resolveAppEnv, type AppEnv } from '../../common/env';

/**
 * Everything the gateway needs from the environment, read once at boot.
 *
 * Boot never dies here. Retell is one integration among several, and a blank
 * `RETELL_API_KEY` used to take the whole API and worker down with it — health, auth,
 * Stripe and Auth0 webhooks included. Instead the config records what is missing, warns
 * once, and `assertConfigured()` turns the first actual Retell call into a clear error.
 * `pnpm doctor` is where a missing key is supposed to be loud, and it is required there
 * from D2.
 *
 * `RETELL_API_KEY` is also the webhook signing secret: Retell signs `x-retell-signature`
 * with HMAC-SHA256 over the raw body using the API key that carries the "webhook" badge
 * in the dashboard (ADR 0003 §A). There is no separate webhook secret, which is why the
 * old `RETELL_WEBHOOK_SECRET` is gone from .env.example.
 *
 * `API_PUBLIC_URL` is where Retell calls back. In dev that is a tunnel; the URL is baked
 * into every agent (`webhook_url`) and number (`inbound_webhook_url`) at create time, so
 * a tunnel that changes hostname strands every object made against the old one.
 */
export class RetellConfig {
  private readonly logger = new Logger(RetellConfig.name);

  /** Empty when unset. Read it through `assertConfigured()`, never directly. */
  readonly apiKey: string;
  readonly publicUrl: string;
  readonly env: AppEnv;
  /** Env vars Retell needs that are not set. Empty means the gateway can talk to Retell. */
  readonly missing: readonly string[];
  /** Wall-clock budget per Retell API call. The inbound hot path never calls Retell. */
  readonly timeoutMs: number;
  /** SDK-level retries with exponential backoff on 408/409/429/5xx and network errors. */
  readonly maxRetries: number;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.apiKey = env.RETELL_API_KEY?.trim() ?? '';
    this.publicUrl = (env.API_PUBLIC_URL?.trim() ?? '').replace(/\/+$/, '');
    this.env = resolveAppEnv(env);
    this.timeoutMs = positiveInt(env, 'RETELL_TIMEOUT_MS', 20_000);
    this.maxRetries = nonNegativeInt(env, 'RETELL_MAX_RETRIES', 3);
    this.missing = (['RETELL_API_KEY', 'API_PUBLIC_URL'] as const).filter((k) => !env[k]?.trim());

    if (this.missing.length) {
      this.logger.warn(
        `Retell is not configured (${this.missing.join(', ')} unset). The API still starts; ` +
          'anything that calls Retell will fail. See the Retell section of .env.example.',
      );
      return;
    }
    if (this.isProd && !/^https:\/\//i.test(this.publicUrl)) {
      throw new Error(`API_PUBLIC_URL must be https in production, got "${this.publicUrl}".`);
    }
    if (!this.isProd && /localhost|127\.0\.0\.1/.test(this.publicUrl)) {
      this.logger.warn(
        `API_PUBLIC_URL is ${this.publicUrl}: Retell cannot reach it. Webhooks will not arrive. ` +
          'Start a tunnel and put its hostname here (docs/runbooks/provisioning.md §5).',
      );
    }
    this.logger.log(`callbacks → ${this.publicUrl}/webhooks/retell (${this.env})`);
  }

  get configured(): boolean {
    return this.missing.length === 0;
  }

  /** Throws unless Retell can actually be reached. Called before every outbound request. */
  assertConfigured(): void {
    if (this.missing.length) {
      throw new Error(`Retell is not configured: ${this.missing.join(', ')} unset. See .env.example.`);
    }
  }

  get isProd(): boolean {
    return this.env === 'prod';
  }

  /** Agent-level webhook (§13.10). Every agent points here. */
  get agentWebhookUrl(): string {
    return `${this.publicUrl}/webhooks/retell`;
  }

  /** Per-number inbound authorisation (§13.9). The token maps to phone_numbers.id. */
  inboundWebhookUrl(numberToken: string): string {
    if (!/^[A-Za-z0-9_-]{8,}$/.test(numberToken)) {
      throw new Error('number_token must be at least 8 URL-safe characters; it is the only thing guarding the route.');
    }
    return `${this.publicUrl}/webhooks/retell/inbound/${numberToken}`;
  }

  /**
   * Retell object names carry the environment so a dashboard full of `dev-` and
   * `staging-` agents is readable and prod is not polluted by test objects. Prod carries
   * no prefix — the customer sees their own agent name in nothing Retell renders, but
   * ops does, in Retell's dashboard.
   */
  objectName(name: string): string {
    return this.isProd ? name : `${this.env}-${name}`;
  }
}

/**
 * `Number(env.X ?? d)` is not enough: an empty or blank value is a string, so `??` never
 * fires and `Number('')` is 0 — `RETELL_TIMEOUT_MS=` would silently mean "give up
 * immediately" and `RETELL_MAX_RETRIES=` "never retry". Blank falls back; garbage throws.
 */
function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = intOrFallback(env, name, fallback);
  if (n <= 0) throw new Error(`${name} must be greater than 0, got "${env[name]}".`);
  return n;
}

function nonNegativeInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  return intOrFallback(env, name, fallback);
}

function intOrFallback(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}".`);
  return n;
}
