import type { FastifyInstance, FastifyRequest } from 'fastify';

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
export function keepsRawBody(request: Pick<FastifyRequest, 'url'>): boolean {
  return request.url.startsWith(WEBHOOK_PATH_PREFIX);
}

/**
 * Replaces Fastify's JSON parser with one that also retains the raw buffer, but only for
 * /webhooks/*. Every other route parses exactly as before and never holds a second copy
 * of its body. This is the "parser scoped to /webhooks/* only" rule from CLAUDE.md, and
 * it is why this lives here rather than as `rawBody: true` on NestFactory — that option
 * is global.
 *
 * Call once in main.ts before `app.init()` / `app.listen()`.
 */
export function registerWebhookRawBody(fastify: FastifyInstance): void {
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, payload, done) => {
      const buffer = payload as Buffer;
      if (keepsRawBody(request)) request.rawBody = buffer;

      // Mirror Fastify's defaults: an empty or malformed JSON body is the caller's fault.
      if (buffer.length === 0) {
        done(badRequest('Body cannot be empty when content-type is application/json'), undefined);
        return;
      }
      try {
        done(null, JSON.parse(buffer.toString('utf8')));
      } catch (error) {
        done(badRequest(error instanceof Error ? error.message : 'Invalid JSON'), undefined);
      }
    },
  );
}

function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}
