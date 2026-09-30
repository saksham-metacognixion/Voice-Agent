import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import * as Sentry from '@sentry/nestjs';
import { resolveAppEnv } from '../common/env/app-env';

/**
 * CLAUDE.md "Observability": OpenTelemetry → Grafana Cloud, Sentry for errors (D14).
 *
 * Both are off unless configured, so a dev box, CI and the e2e suites run exactly as
 * before:
 *   - traces:  `OTEL_EXPORTER_OTLP_ENDPOINT` (+ `OTEL_EXPORTER_OTLP_HEADERS`, the Grafana
 *              Cloud `Authorization=Basic …`), read by the SDK itself; sampling is the
 *              standard `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`.
 *   - errors:  `SENTRY_DSN`; `SENTRY_RELEASE` (compose passes the image tag).
 *
 * Loaded by `register-api.ts` / `register-worker.ts`, the first import of each entrypoint:
 * instrumentation patches modules as they are required, so anything loaded before it —
 * Nest, ioredis, Prisma — would go untraced.
 *
 * Sentry 11 installs no tracer provider of its own (`enableOpenTelemetrySetup` defaults to
 * false), so the two do not fight over the global OpenTelemetry API: OTel owns traces,
 * Sentry owns errors, and every Sentry event carries the OTel `trace_id` so an error in
 * Sentry opens the matching trace in Grafana.
 *
 * What never leaves the box: request bodies (a brief, a SIP password, a document), cookies
 * and every credential-shaped header (`dataCollection`, then `scrubEvent` as a backstop).
 */

export type ServiceRole = 'api' | 'worker';

let started = false;
let sentryOn = false;

export function startObservability(role: ServiceRole, env: NodeJS.ProcessEnv = process.env): void {
  if (started) return;
  started = true;
  const service = env.OTEL_SERVICE_NAME?.trim() || `oraly-${role}`;
  const appEnv = resolveAppEnv(env);

  if (env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() && env.OTEL_SDK_DISABLED !== 'true') {
    startTracing(service, appEnv, env);
  }

  const dsn = env.SENTRY_DSN?.trim();
  if (dsn) {
    Sentry.init({
      dsn,
      environment: appEnv,
      release: env.SENTRY_RELEASE?.trim() || undefined,
      serverName: service,
      // Sentry 11 collects everything by default. Off: bodies (a brief, a SIP password, a
      // document), cookies, query strings (a signed recording token), user info, database
      // query data (a balance), queue payloads and stack-frame variables (a decrypted secret
      // in scope). Request headers are kept — minus the allow-list's absence of credentials.
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: {
          request: {
            allow: ['user-agent', 'content-type', 'x-workspace-id', 'x-request-id', 'origin'],
          },
          response: false,
        },
        httpBodies: [],
        urlQueryParams: false,
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        stackFrameVariables: false,
      },
      // Errors only: traces are OpenTelemetry's job, and a second sampler would bill twice.
      tracesSampleRate: 0,
      beforeSend: (event) => scrubEvent(event),
      initialScope: { tags: { service } },
      // Error capture only. Sentry's HTTP/framework instrumentation and session tracking
      // cost the §13.9 inbound path more than half its throughput on the D14 k6 run (6 812
      // → 2 743 req/s) for spans OpenTelemetry already records; the exception filter and
      // `reportError` attach the route and trace id themselves.
      integrations: (defaults) =>
        defaults.filter((integration) => SENTRY_KEEP.has(integration.name)),
    });
    sentryOn = true;
  }
}

function startTracing(service: string, appEnv: string, env: NodeJS.ProcessEnv): void {
  // Required lazily: with tracing off, none of the SDK or its patches load.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { NodeSDK } =
    require('@opentelemetry/sdk-node') as typeof import('@opentelemetry/sdk-node');
  const { OTLPTraceExporter } =
    require('@opentelemetry/exporter-trace-otlp-proto') as typeof import('@opentelemetry/exporter-trace-otlp-proto');
  const { resourceFromAttributes } =
    require('@opentelemetry/resources') as typeof import('@opentelemetry/resources');
  const { HttpInstrumentation } =
    require('@opentelemetry/instrumentation-http') as typeof import('@opentelemetry/instrumentation-http');
  const { UndiciInstrumentation } =
    require('@opentelemetry/instrumentation-undici') as typeof import('@opentelemetry/instrumentation-undici');
  const { IORedisInstrumentation } =
    require('@opentelemetry/instrumentation-ioredis') as typeof import('@opentelemetry/instrumentation-ioredis');
  const { NestInstrumentation } =
    require('@opentelemetry/instrumentation-nestjs-core') as typeof import('@opentelemetry/instrumentation-nestjs-core');
  const { PrismaInstrumentation } =
    require('@prisma/instrumentation') as typeof import('@prisma/instrumentation');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': service,
      'service.version': env.SENTRY_RELEASE?.trim() || 'dev',
      'deployment.environment.name': appEnv,
    }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        // Liveness probes every few seconds would drown every other trace.
        ignoreIncomingRequestHook: (request) => (request.url ?? '').startsWith('/health'),
        // Never record a query string: recording links carry a signed token there.
        requestHook: (span, request) => {
          const url = 'url' in request && typeof request.url === 'string' ? request.url : undefined;
          if (url) span.setAttribute('url.path', url.split('?')[0] ?? url);
        },
      }),
      // fetch(): Retell, Stripe, Anthropic, Auth0 and the ops webhook.
      new UndiciInstrumentation(),
      // BullMQ rides on ioredis too; `db.statement` is off so no key value (a balance, a
      // reservation) is copied into a span.
      new IORedisInstrumentation({ dbStatementSerializer: (command) => command }),
      new NestInstrumentation(),
      new PrismaInstrumentation(),
    ],
  });
  sdk.start();

  const shutdown = () => {
    void sdk.shutdown().catch(() => undefined);
  };
  process.once('SIGTERM', shutdown);
  process.once('beforeExit', shutdown);
}

/** Error reporting for code paths the HTTP filter never sees (a job that failed for good). */
export function reportError(
  error: unknown,
  context: { tags?: Record<string, string>; extra?: Record<string, unknown> } = {},
): void {
  if (!sentryOn) return;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(context.tags ?? {})) scope.setTag(key, value);
    if (context.extra) scope.setExtras(context.extra);
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    if (traceId) scope.setTag('trace_id', traceId);
    Sentry.captureException(error);
  });
}

/**
 * Marks the active span as failed without throwing. For a handler that settles a failure
 * itself and returns — BullMQ then records success and `inSpan` would end the span OK,
 * so the trace would never show the job as an error.
 */
export function failActiveSpan(error: unknown): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Wraps one unit of background work in a span, for what no instrumentation sees: a BullMQ
 * job is a Redis BLMOVE, not an HTTP request, so without this every queued piece of work
 * — a `call_ended` debit, a generation, an activation — would be a trace-less orphan.
 */
export async function inSpan<T>(
  name: string,
  attributes: Record<string, string | number>,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return trace.getTracer('oraly').startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

const SENTRY_KEEP = new Set([
  'EventFilters',
  'FunctionToString',
  'LinkedErrors',
  'NodeSystemError',
  'OnUncaughtException',
  'OnUnhandledRejection',
  'ContextLines',
  'Context',
  'Modules',
]);

const SECRET_HEADERS =
  /^(authorization|cookie|set-cookie|x-action-secret|x-retell-signature|stripe-signature|x-api-key|proxy-authorization)$/i;

export function scrubEvent<E extends Sentry.ErrorEvent>(event: E): E {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  if (traceId) event.tags = { ...event.tags, trace_id: traceId };
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.query_string) event.request.query_string = '[redacted]';
    if (event.request.url) event.request.url = event.request.url.split('?')[0];
    if (event.request.headers) {
      for (const name of Object.keys(event.request.headers)) {
        if (SECRET_HEADERS.test(name)) event.request.headers[name] = '[redacted]';
      }
    }
  }
  return event;
}
