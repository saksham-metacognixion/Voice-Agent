import { createHash } from 'node:crypto';
import { Body, Controller, HttpCode, Logger, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../../common/errors/app-error';
import { Public } from '../auth';
import { StripeGateway } from '../billing';
import { InboundAuthorizationService } from '../calls';
import { JobQueues } from '../jobs';
import { RetellGateway, callIdOf, retellInboundEvent } from '../retell';
import { FixtureWriter } from './fixture-writer.service';
import { WebhookEventsService } from './webhook-events.service';

/**
 * Webhook receivers (§13.10, §14.2). Every route is `@Public()` — Retell, Stripe and
 * Auth0 cannot hold a JWT (§16) — and every route follows the same four steps:
 *
 *   1. verify the signature over `request.rawBody`     → 401, nothing stored
 *   2. upsert `webhook_events` (provider, external_id, event_type)
 *   3. duplicate of a *processed* event                → 204, do nothing
 *   4. enqueue on the `webhooks` queue                 → 200 `{received:true}`, fast
 *
 * Processing, retries and backoff are BullMQ's (architecture §11). **Nothing here returns
 * 5xx to a provider after the event is stored**: for Retell a retry storm answers a live
 * call (ADR 0003 §1), and for Stripe the row plus the sweeper is a better queue than three
 * days of provider retries — which retires the D3 exception in ADR 0010 §5.
 *
 * `/webhooks/retell/inbound/:number_token` is the exception to all of it: it is the §13.9
 * hot path, it stores nothing inline, and its whole job is to answer in under 300 ms.
 */
@Public()
@Controller('webhooks')
export class WebhooksController {
  private readonly log = new Logger(WebhooksController.name);

  constructor(
    private readonly fixtures: FixtureWriter,
    private readonly retell: RetellGateway,
    private readonly stripeGateway: StripeGateway,
    private readonly events: WebhookEventsService,
    private readonly inbound: InboundAuthorizationService,
    private readonly queues: JobQueues,
  ) {}

  private async retellSignature(request: FastifyRequest): Promise<boolean> {
    const header = request.headers['x-retell-signature'];
    const value = Array.isArray(header) ? header[0] : header;
    return this.retell.verifyWebhookSignature(request.rawBody, value);
  }

  /**
   * `call_started`, `call_ended`, `call_analyzed`, `transfer_*` — the agent's `webhook_url`.
   *
   * `external_id` is the `call_id`, and the identity of an event is
   * `(provider, call_id, event_type)`: one call produces three events that all carry the
   * same id (architecture §11). A payload with no call id at all is deduped on a digest of
   * its bytes instead, so a replay of it is still exactly once.
   */
  @Post('retell')
  async retellEvents(@Req() request: FastifyRequest, @Body() body: unknown, @Res() reply: FastifyReply): Promise<void> {
    const valid = await this.retellSignature(request);
    const eventType = stringField(body, 'event') ?? 'unknown';
    await this.fixtures.capture({
      provider: 'retell',
      eventType,
      path: request.url,
      headers: request.headers,
      raw: request.rawBody,
      body,
      signatureValid: valid,
    });
    if (!valid) {
      this.log.warn(`x-retell-signature did not verify on ${request.url}; refusing`);
      throw new AppError('INVALID_SIGNATURE', 'Retell signature did not verify.');
    }

    const externalId = callIdOf(body) ?? `body:${digest(request.rawBody)}`;
    const stored = await this.events.store({ provider: 'retell', externalId, eventType, payload: body });
    if (stored.kind === 'duplicate') {
      void reply.code(204).send();
      return;
    }

    // Stored, so we owe Retell nothing further. An enqueue that fails is picked up by the
    // webhook-sweeper within a minute — still never a 5xx to Retell.
    const queued = await this.queues.enqueueWebhook(stored.id, 'retell');
    if (queued === 'failed') this.log.error(`retell ${eventType} ${externalId}: stored but not queued; the sweeper will retry`);
    void reply.code(200).send({ received: true });
  }

  /**
   * §13.9 inbound authorisation. Redis-only, p95 < 300 ms, and the one route that answers
   * before anything is written: the `calls` row for both outcomes is an enqueued job.
   *
   * A signature that does not verify is **not** a 4xx here. Retell treats any non-2xx as a
   * failure, retries three times and then answers with the number's bound agent anyway
   * (ADR 0003 §1) — so a 401 costs the caller two seconds of ringing and changes nothing.
   * We answer `200 {}` with no side effects instead, and say so loudly: a forged request
   * achieves nothing, and a real one with a mis-badged API key still gets the call answered.
   */
  @Post('retell/inbound/:number_token')
  async retellInbound(
    @Param('number_token') numberToken: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Body() body: unknown,
  ): Promise<void> {
    const valid = await this.retellSignature(request);
    if (!valid) {
      this.log.error(`x-retell-signature did not verify on the inbound path (token ${numberToken}); answering {} without authorising`);
      void reply.code(200).send({});
      await this.captureInbound(request, body, valid, { answered: 'fail_open', reason: 'bad_signature' });
      return;
    }

    const parsed = retellInboundEvent.safeParse(body);
    if (!parsed.success) {
      // Malformed body: nothing to authorise against, and a decline would be a busy tone
      // for a caller who did nothing wrong. Fail open, exactly as for an unknown number.
      this.log.error(`inbound webhook body is malformed (token ${numberToken}): ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      void reply.code(200).send({});
      await this.captureInbound(request, body, valid, { answered: 'fail_open', reason: 'malformed' });
      return;
    }

    const outcome = await this.inbound.authorize(numberToken, parsed.data);
    void reply.code(200).send(outcome.body);
    // After the answer: the fixture write must never be inside the latency budget.
    await this.captureInbound(request, body, valid, {
      answered: outcome.answered,
      latency_ms: Number(outcome.latencyMs.toFixed(1)),
      body: outcome.body,
      warnings: outcome.warnings,
    });
  }

  /**
   * Stripe (§13.7, §13.10). Same four steps as Retell since D4: verify → store → 204 on a
   * duplicate → enqueue → 200. Processing no longer runs inline, so a transient failure is
   * a BullMQ retry rather than a 500 that asks Stripe to retry for three days.
   */
  @Post('stripe')
  async stripe(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const header = request.headers['stripe-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!request.rawBody || !signature) throw new AppError('INVALID_SIGNATURE', 'Missing Stripe signature.');

    let event;
    try {
      event = this.stripeGateway.constructEvent(request.rawBody, signature);
    } catch (error) {
      this.log.warn(`stripe-signature did not verify: ${error instanceof Error ? error.message : String(error)}`);
      throw new AppError('INVALID_SIGNATURE', 'Stripe signature did not verify.');
    }

    await this.fixtures.capture({
      provider: 'stripe',
      eventType: event.type,
      path: request.url,
      headers: request.headers,
      raw: request.rawBody,
      body: event,
      signatureValid: true,
    });

    const stored = await this.events.store({ provider: 'stripe', externalId: event.id, eventType: event.type, payload: event });
    if (stored.kind === 'duplicate') {
      void reply.code(204).send();
      return;
    }
    const queued = await this.queues.enqueueWebhook(stored.id, 'stripe');
    if (queued === 'failed') this.log.error(`stripe ${event.type} ${event.id}: stored but not queued; the sweeper will retry`);
    void reply.code(200).send({ received: true });
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

  /**
   * Opt-in only (`CAPTURE_INBOUND_FIXTURES=true`): this is the one route that can arrive
   * thousands of times a minute, and a file per request is disk I/O next to a 300 ms SLO.
   */
  private captureInbound(request: FastifyRequest, body: unknown, signatureValid: boolean, response: unknown): Promise<unknown> {
    return this.fixtures.captureInbound({
      provider: 'retell',
      eventType: stringField(body, 'event') ?? 'call_inbound',
      path: request.url,
      headers: request.headers,
      raw: request.rawBody,
      body,
      signatureValid,
      response,
    });
  }
}

function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Dedupe key for a payload that carries no call id: the bytes themselves. */
function digest(raw: Buffer | undefined): string {
  return createHash('sha256').update(raw ?? Buffer.alloc(0)).digest('hex').slice(0, 32);
}
