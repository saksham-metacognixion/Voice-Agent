import { Logger } from '@nestjs/common';
import { resolveAppEnv, type AppEnv, portalUrl } from '../../common/env';

/**
 * Stripe settings, read once. Like RetellConfig: boot never dies here. A blank key
 * records what is missing and the first checkout fails with a clear message; `pnpm
 * doctor` is where it is loud (required from D3).
 *
 * Test and live keys never mix (§13.12): outside prod a live key is refused outright.
 */
export class StripeConfig {
  private readonly logger = new Logger(StripeConfig.name);

  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly portalUrl: string;
  readonly env: AppEnv;
  readonly missing: readonly string[];

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.secretKey = env.STRIPE_SECRET_KEY?.trim() ?? '';
    this.webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? '';
    this.portalUrl = portalUrl(env);
    this.env = resolveAppEnv(env);
    this.missing = (['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const).filter((k) => !env[k]?.trim());

    if (this.missing.length) {
      this.logger.warn(`Stripe is not configured (${this.missing.join(', ')} unset). Checkout and /webhooks/stripe will refuse until it is.`);
      return;
    }
    const live = this.secretKey.startsWith('sk_live_') || this.secretKey.startsWith('rk_live_');
    if (live && this.env !== 'prod') {
      throw new Error(`STRIPE_SECRET_KEY is a live key but APP_ENV=${this.env}. Test and live keys never mix (§13.12).`);
    }
    if (!live && this.env === 'prod') {
      this.logger.warn('STRIPE_SECRET_KEY is a test-mode key in prod; purchases will not be real money.');
    }
    this.logger.log(`stripe ${live ? 'live' : 'test'} mode; checkout returns to ${this.portalUrl}`);
  }

  get configured(): boolean {
    return this.missing.length === 0;
  }

  assertConfigured(): void {
    if (this.missing.length) {
      throw new Error(`Stripe is not configured: ${this.missing.join(', ')} unset. See .env.example.`);
    }
  }

  /** W7: `/onboarding/activate?session_id=…` (§13.7). Stripe fills the placeholder. */
  get successUrl(): string {
    return `${this.portalUrl}/onboarding/activate?session_id={CHECKOUT_SESSION_ID}`;
  }

  get cancelUrl(): string {
    return `${this.portalUrl}/app/wallet?checkout=cancelled`;
  }
}
