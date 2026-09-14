import { Body, Controller, HttpCode, Logger, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Public } from '../auth';
import { FixtureWriter } from './fixture-writer.service';

/**
 * How the inbound-authorisation stub answers Retell. The real endpoint (§13.9) decides
 * allow/decline from Redis; this one decides from configuration so D2 can observe what
 * Retell actually does with each kind of answer — which is §21's open question, and the
 * reason the Redis-down policy in ADR 0003 cannot be written until it is answered.
 *
 *   allow            200 with RETELL_INBOUND_RESPONSE_JSON, or `{}` when unset
 *   decline_403      403, empty body
 *   decline_404      404, empty body
 *   decline_500      500, empty body
 *   decline_timeout  wait RETELL_INBOUND_TIMEOUT_MS (default 15 000) then 200 — Retell
 *                    gives up at 10 s, so this shows the timeout behaviour
 *
 * Chosen by `?mode=` on the configured URL, falling back to RETELL_INBOUND_MODE.
 */
const INBOUND_MODES = ['allow', 'decline_403', 'decline_404', 'decline_500', 'decline_timeout'] as const;
type InboundMode = (typeof INBOUND_MODES)[number];

/**
 * Webhook receivers, D2 capture edition.
 *
 * Every route here is @Public() — Retell, Stripe and Auth0 cannot hold a JWT (§16). What
 * these do today: keep the raw body, write the payload to a fixture, answer 2xx fast.
 * What they do NOT do yet, and where it lands:
 *
 *   signature verification on request.rawBody        D3 (Stripe), D3/D4 (Retell)
 *   upsert webhook_events (provider, external_id, event_type), 204 on duplicate   D3
 *   hand-off to BullMQ; never a 5xx to the provider once the event is stored       D3
 *   the six §13.9 checks against Redis on the inbound path                          D4
 *
 * The route shapes and the raw-body rule are permanent. The handler bodies are not.
 */
@Public()
@Controller('webhooks')
export class WebhooksController {
  private readonly log = new Logger(WebhooksController.name);

  constructor(private readonly fixtures: FixtureWriter) {}

  /** call_started, call_ended, call_analyzed, transfer_* — set as the agent's webhook_url. */
  @Post('retell')
  @HttpCode(200)
  async retell(@Req() request: FastifyRequest, @Body() body: unknown): Promise<{ received: true }> {
    await this.fixtures.capture({
      provider: 'retell',
      eventType: stringField(body, 'event') ?? 'unknown',
      path: request.url,
      headers: request.headers,
      raw: request.rawBody,
      body,
    });
    return { received: true };
  }

  /**
   * Per-number inbound authorisation — set as the phone number's inbound_webhook_url.
   * Retell times out at 10 s and retries 3×; the production budget is p95 < 300 ms.
   */
  @Post('retell/inbound/:number_token')
  async retellInbound(
    @Param('number_token') numberToken: string,
    @Query('mode') queryMode: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<void> {
    await this.fixtures.capture({
      provider: 'retell',
      eventType: stringField(body, 'event') ?? 'call_inbound',
      path: request.url,
      headers: request.headers,
      raw: request.rawBody,
      body,
    });

    const mode = resolveMode(queryMode ?? process.env.RETELL_INBOUND_MODE);
    this.log.log(`inbound token=${numberToken} mode=${mode}`);

    switch (mode) {
      case 'decline_403':
        void reply.code(403).send();
        return;
      case 'decline_404':
        void reply.code(404).send();
        return;
      case 'decline_500':
        void reply.code(500).send();
        return;
      case 'decline_timeout': {
        const ms = Number(process.env.RETELL_INBOUND_TIMEOUT_MS ?? 15_000);
        await new Promise((resolve) => setTimeout(resolve, ms));
        void reply.code(200).send({});
        return;
      }
      case 'allow':
        void reply.code(200).send(allowResponse());
        return;
    }
  }

  /** checkout.session.* and charge.dispute.created, via `stripe listen` in dev. */
  @Post('stripe')
  @HttpCode(200)
  async stripe(@Req() request: FastifyRequest, @Body() body: unknown): Promise<{ received: true }> {
    await this.fixtures.capture({
      provider: 'stripe',
      eventType: stringField(body, 'type') ?? 'unknown',
      path: request.url,
      headers: request.headers,
      raw: request.rawBody,
      body,
    });
    return { received: true };
  }

  /** Auth0 Post-User-Registration Action (infra/auth0/actions/). Shared-secret header. */
  @Post('auth')
  @HttpCode(200)
  async auth(@Req() request: FastifyRequest, @Body() body: unknown): Promise<{ received: true }> {
    await this.fixtures.capture({
      provider: 'auth',
      eventType: 'post_user_registration',
      path: request.url,
      headers: request.headers,
      raw: request.rawBody,
      body,
    });
    return { received: true };
  }
}

function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function resolveMode(value: string | undefined): InboundMode {
  return (INBOUND_MODES as readonly string[]).includes(value ?? '') ? (value as InboundMode) : 'allow';
}

/**
 * Whatever JSON RETELL_INBOUND_RESPONSE_JSON holds, or `{}`. The shape Retell expects
 * back from an inbound webhook — override_agent_id, dynamic_variables, and whether a
 * max-duration override is honoured here — is what D2 establishes, so the response is
 * data, not code. Malformed JSON is logged and treated as `{}` rather than 500ing a call.
 */
function allowResponse(): unknown {
  const configured = process.env.RETELL_INBOUND_RESPONSE_JSON;
  if (!configured) return {};
  try {
    return JSON.parse(configured);
  } catch {
    new Logger(WebhooksController.name).warn('RETELL_INBOUND_RESPONSE_JSON is not valid JSON; answering {}');
    return {};
  }
}
