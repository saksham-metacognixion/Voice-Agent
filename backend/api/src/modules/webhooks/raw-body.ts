import { parse as parseQuerystring } from 'node:querystring';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** Every provider webhook lives under here (§16): retell, retell/inbound, stripe, auth. */
export const WEBHOOK_PATH_PREFIX = '/webhooks/';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The request body exactly as it arrived on the wire. Set only under
     * WEBHOOK_PATH_PREFIX — signature verification (§13.10, §14.2) is an HMAC over these
     * bytes, and re-serialising the parsed object changes key order and whitespace, so
     * verifying against JSON.stringify(body) fails every single time.
     */
    rawBody?: Buffer;
  }
}

/** True when this request should keep its raw bytes. Exported for the unit test. */
export function keepsRawBody(request: Pick<RawRequest, 'url'>): boolean {
  return request.url.startsWith(WEBHOOK_PATH_PREFIX);
}

/*
 * Typed against the minimum we touch rather than FastifyRequest. platform-fastify
 * resolves its own copy of fastify (5.11 next to this package's 5.12 today) and the two
 * request types are unrelated to TypeScript, so a parser written against either one
 * fails to type-check against the other. At runtime they are the same object.
 */
type RawRequest = { url: string; rawBody?: Buffer };
type Done = (error: Error | null, body?: unknown) => void;
export type BufferParser = (request: RawRequest, body: Buffer, done: Done) => void;

type PoisoningAction = 'error' | 'remove' | 'ignore';
interface ParserSource {
  initialConfig: {
    bodyLimit?: number;
    onProtoPoisoning?: PoisoningAction;
    onConstructorPoisoning?: PoisoningAction;
  };
  getDefaultJsonParser(onProto: PoisoningAction, onConstructor: PoisoningAction): unknown;
}

/**
 * Fastify's own JSON parser — same prototype-poisoning guards, same 400s on an empty or
 * malformed body — with one addition: under /webhooks/* the raw buffer is kept on the
 * request first. Exported so the test can mount it on a bare Fastify instance.
 */
export function createWebhookJsonParser(instance: ParserSource): BufferParser {
  const { onProtoPoisoning = 'error', onConstructorPoisoning = 'error' } = instance.initialConfig;
  const parseJson = instance.getDefaultJsonParser(onProtoPoisoning, onConstructorPoisoning) as BufferParser;
  return (request, body, done) => {
    if (keepsRawBody(request)) request.rawBody = body;
    parseJson(request, body, done);
  };
}

/**
 * Installs the webhook-aware JSON parser on a Nest + Fastify app. Call after
 * NestFactory.create() and before init()/listen().
 *
 * Why app.useBodyParser() and not fastify.addContentTypeParser(): Nest registers its own
 * 'application/json' parser during init(), and Fastify throws on a second parser for the
 * same type — a hand-registered one collides at boot. useBodyParser() is the documented
 * override; it also marks the parsers as registered so Nest skips its defaults. That
 * skip covers urlencoded too, so it is re-added here to keep behaviour identical.
 *
 * Why not `rawBody: true` on NestFactory: that keeps a second copy of every request body
 * on every route. Only /webhooks/* needs it (CLAUDE.md, "parser scoped to /webhooks/*").
 */
export function registerWebhookRawBody(app: NestFastifyApplication): void {
  const instance = app.getHttpAdapter().getInstance() as unknown as ParserSource;
  const { bodyLimit } = instance.initialConfig;

  // useBodyParser is generic over Nest's fastify types; see the note on RawRequest above.
  const use = app.useBodyParser.bind(app) as unknown as (
    type: string,
    options: { bodyLimit?: number },
    parser: BufferParser,
  ) => void;

  use('application/json', { bodyLimit }, createWebhookJsonParser(instance));
  use('application/x-www-form-urlencoded', { bodyLimit }, (_request, body, done) => {
    done(null, parseQuerystring(body.toString()));
  });
}
