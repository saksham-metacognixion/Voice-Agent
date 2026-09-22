import { z } from 'zod';
import * as schemas from '@portal/schemas';
import { ERROR_STATUS, type ErrorCode } from '@portal/schemas';
import { zodV3ToOpenAPI } from 'nestjs-zod';
import { type DiscoveredRoute } from './discover';
import { type EndpointSpec, MANIFEST, type ResponseRef } from './manifest';

/*
 * Turns the manifest × the discovered routes into two artefacts:
 *
 *   1. an OpenAPI 3.1 document (`docs/api/openapi.json`) — every route, its request and
 *      response schemas converted from the zod definitions in `@portal/schemas`, its error
 *      codes with their statuses, and how it authenticates;
 *   2. the typed client (`frontend/api-client/src/generated/endpoints.ts`) — one function
 *      per operation over `ApiClient`, parsing the response against the same zod schema,
 *      plus a TanStack Query hook for each.
 *
 * Both are pure functions of their inputs and sorted, so a regeneration with no contract
 * change is byte-identical and `--check` can diff.
 */

export interface Joined {
  spec: EndpointSpec;
  route: DiscoveredRoute;
}

/** Joins the manifest with the discovered routes and refuses any one-sided entry or a role mismatch. */
export function join(routes: readonly DiscoveredRoute[]): Joined[] {
  const key = (m: string, p: string) => `${m} ${p}`;
  const byKey = new Map(routes.map((r) => [key(r.method, r.path), r]));
  const problems: string[] = [];
  const joined: Joined[] = [];
  const seen = new Set<string>();
  for (const spec of MANIFEST) {
    const k = key(spec.method, spec.path);
    if (seen.has(k)) problems.push(`manifest lists ${k} twice`);
    seen.add(k);
    const route = byKey.get(k);
    if (!route) {
      problems.push(`manifest has ${k} but no controller serves it`);
      continue;
    }
    if (spec.roles && JSON.stringify([...spec.roles].sort()) !== JSON.stringify([...(route.roles ?? [])].sort())) {
      problems.push(`${k}: manifest roles ${JSON.stringify(spec.roles)} ≠ controller @Roles ${JSON.stringify(route.roles)}`);
    }
    if (!spec.roles && route.roles) problems.push(`${k}: controller has @Roles(${route.roles.join(', ')}) but the manifest lists none`);
    if (spec.webhook && !route.isPublic) problems.push(`${k}: a webhook must be @Public()`);
    for (const name of [spec.body, spec.query, ...schemaNames(spec.response)]) {
      if (name && !isZod((schemas as Record<string, unknown>)[name])) problems.push(`${k}: "${name}" is not a zod schema exported by @portal/schemas`);
    }
    joined.push({ spec, route });
  }
  for (const route of routes) {
    if (!seen.has(key(route.method, route.path))) problems.push(`${route.controller}.${route.handler} serves ${route.method} ${route.path} but the manifest does not list it`);
  }
  if (problems.length) throw new Error(`OpenAPI manifest and controllers disagree:\n  - ${problems.join('\n  - ')}`);
  return joined.sort((a, b) => a.spec.path.localeCompare(b.spec.path) || a.spec.method.localeCompare(b.spec.method));
}

// ---------------------------------------------------------------------------- OpenAPI

const AUTH_CODES = {
  bearer: ['UNAUTHENTICATED', 'INVALID_TOKEN'] as ErrorCode[],
  workspace: ['WORKSPACE_REQUIRED', 'NOT_A_MEMBER', 'WORKSPACE_PAUSED'] as ErrorCode[],
};

export function buildOpenApi(joined: readonly Joined[], version: string): Record<string, unknown> {
  const components: Record<string, unknown> = {};
  const use = (name: string): { $ref: string } => {
    if (!components[name]) components[name] = toOpenApi((schemas as Record<string, unknown>)[name]);
    return { $ref: `#/components/schemas/${name}` };
  };
  use('errorResponse');

  const paths: Record<string, Record<string, unknown>> = {};
  for (const { spec, route } of joined) {
    const oaPath = spec.path.replace(/:([A-Za-z_]+)/g, '{$1}');
    const parameters: unknown[] = [];
    for (const name of pathParams(spec.path)) parameters.push({ name, in: 'path', required: true, schema: { type: 'string' } });
    if (spec.query) {
      const q = (schemas as Record<string, unknown>)[spec.query] as z.ZodTypeAny;
      for (const [name, field] of Object.entries(objectShape(q))) {
        parameters.push({ name, in: 'query', required: !field.isOptional(), schema: toOpenApi(field) });
      }
    }
    const workspaceScoped = !route.isPublic && !route.noWorkspace;
    if (workspaceScoped) parameters.push({ $ref: '#/components/parameters/WorkspaceId' });
    if (spec.webhook) parameters.push({ $ref: `#/components/parameters/${spec.webhook === 'stripe' ? 'StripeSignature' : spec.webhook === 'retell' ? 'RetellSignature' : 'Auth0Secret'}` });

    const errors = new Set<ErrorCode>(spec.errors ?? []);
    if (!route.isPublic) for (const c of AUTH_CODES.bearer) errors.add(c);
    if (workspaceScoped) for (const c of AUTH_CODES.workspace) errors.add(c);
    if (route.roles) errors.add('FORBIDDEN_ROLE');
    if (route.requireEmailVerified) errors.add('EMAIL_UNVERIFIED');
    if (spec.body || spec.query) errors.add('VALIDATION_FAILED');
    const byStatus = new Map<number, ErrorCode[]>();
    for (const code of errors) byStatus.set(ERROR_STATUS[code], [...(byStatus.get(ERROR_STATUS[code]) ?? []), code].sort());

    const responses: Record<string, unknown> = {};
    responses[String(route.status)] = successResponse(spec.response, use);
    if (spec.webhook) responses['204'] = { description: 'Duplicate of an event already processed — nothing to do (§13.10).' };
    for (const [status, codes] of [...byStatus.entries()].sort((a, b) => a[0] - b[0])) {
      responses[String(status)] = {
        description: `Error envelope; \`code\` ∈ {${codes.join(', ')}}`,
        'x-error-codes': codes,
        content: { 'application/json': { schema: use('errorResponse') } },
      };
    }

    const operation: Record<string, unknown> = {
      operationId: spec.operationId,
      summary: spec.summary,
      tags: [spec.tag],
      ...(spec.spec ? { description: `Spec ${spec.spec}.` } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(spec.body ? { requestBody: { required: true, content: { 'application/json': { schema: use(spec.body) } } } } : {}),
      responses,
      security: route.isPublic ? [] : [{ bearerAuth: [] }],
      'x-auth': route.isPublic ? (spec.webhook ? `webhook:${spec.webhook}` : 'public') : route.noWorkspace ? 'user' : 'workspace',
      ...(route.roles ? { 'x-roles': route.roles } : {}),
      ...(route.requireEmailVerified ? { 'x-email-verified': true } : {}),
      ...(spec.client === false ? { 'x-client': false } : {}),
    };
    paths[oaPath] = { ...(paths[oaPath] ?? {}), [spec.method.toLowerCase()]: operation };
  }

  return sortKeys({
    openapi: '3.1.0',
    info: {
      title: 'Voice Agent Portal API',
      version,
      description:
        'Customer-facing API of the Voice Agent Self-Service Portal (spec §16). Every non-public route takes `Authorization: Bearer <jwt>`; workspace-scoped routes also take `X-Workspace-Id`. Errors are `{code, message, fields?}`. Long operations answer `202 {job_id}` and progress over `GET /events` (SSE) or `GET /jobs/:id`. Generated from backend/api/src/openapi/manifest.ts — do not edit by hand.',
    },
    servers: [
      { url: 'https://api.{domain}', variables: { domain: { default: 'example.com' } } },
      { url: 'http://localhost:4000', description: 'local dev' },
    ],
    tags: [...new Set(joined.map((j) => j.spec.tag))].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Auth0 access token (customer tenant). ADR 0002.' } },
      parameters: {
        WorkspaceId: { name: 'X-Workspace-Id', in: 'header', required: true, schema: { type: 'string', format: 'uuid' }, description: 'The workspace the request acts in; the caller must be a member (§6.2).' },
        RetellSignature: { name: 'x-retell-signature', in: 'header', required: true, schema: { type: 'string' }, description: 'HMAC-SHA256 over the raw body, keyed with the Retell API key (ADR 0003).' },
        StripeSignature: { name: 'stripe-signature', in: 'header', required: true, schema: { type: 'string' }, description: 'Stripe webhook signature over the raw body.' },
        Auth0Secret: { name: 'x-portal-auth-secret', in: 'header', required: true, schema: { type: 'string' }, description: 'Shared secret set on the Auth0 Actions (AUTH0_CUSTOMER_ACTION_SECRET).' },
      },
      schemas: components,
    },
  }) as Record<string, unknown>;
}

function successResponse(ref: ResponseRef, use: (name: string) => { $ref: string }): unknown {
  if ('none' in ref) return { description: 'OK. The body depends on the decision (see the summary).' };
  if ('stream' in ref) return { description: ref.stream === 'text/event-stream' ? 'A stream of `sseEvent` frames.' : 'The bytes.', content: { [ref.stream]: { schema: ref.stream === 'text/event-stream' ? use('sseEvent') : { type: 'string', format: 'binary' } } } };
  if ('array' in ref) return { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: use(ref.array) } } } };
  if ('paginated' in ref) {
    return {
      description: 'One page (§16 cursor pagination).',
      content: { 'application/json': { schema: { type: 'object', required: ['items', 'next_cursor'], properties: { items: { type: 'array', items: use(ref.paginated) }, next_cursor: { type: ['string', 'null'] } } } } },
    };
  }
  const schema = use(ref.schema);
  return { description: 'OK', content: { 'application/json': { schema: ref.nullable ? { oneOf: [schema, { type: 'null' }] } : schema } } };
}

// ---------------------------------------------------------------------------- client

export function buildClient(joined: readonly Joined[]): string {
  const ops = joined.filter((j) => j.spec.client !== false);
  const imports = new Set<string>();
  for (const { spec } of ops) {
    for (const name of [spec.body, spec.query, ...schemaNames(spec.response)]) if (name) imports.add(name);
    if ('paginated' in spec.response) imports.add('paginated');
  }
  const lines: string[] = [
    '/* eslint-disable */',
    '// GENERATED FILE — do not edit.',
    '// Source: backend/api/src/openapi/manifest.ts joined with the controllers’ route metadata.',
    '// Regenerate: pnpm --filter @portal/api openapi:generate   Verify: pnpm --filter @portal/api openapi:check',
    "import { useMutation, useQuery } from '@tanstack/react-query';",
    "import type { z } from 'zod';",
    `import { ${[...imports].sort().join(', ')} } from '@portal/schemas';`,
    "import type { ApiClient } from '../client';",
    '',
    'const enc = encodeURIComponent;',
    '',
    '/** Query string from a query object; undefined and null fields are left out. */',
    'export function qs(query: Record<string, unknown> | undefined): string {',
    '  if (!query) return \'\';',
    '  const parts: string[] = [];',
    '  for (const [k, v] of Object.entries(query)) {',
    '    if (v === undefined || v === null) continue;',
    '    parts.push(`${enc(k)}=${enc(String(v))}`);',
    '  }',
    "  return parts.length ? `?${parts.join('&')}` : '';",
    '}',
    '',
    'export interface QueryHookOptions {',
    '  enabled?: boolean;',
    '  staleTime?: number;',
    '  refetchInterval?: number | false;',
    '}',
    '',
  ];

  for (const { spec, route } of ops) {
    const params = pathParams(spec.path);
    const paramsType = params.length ? `{ ${params.map((p) => `${p}: string`).join('; ')} }` : null;
    const url = '`' + spec.path.replace(/:([A-Za-z_]+)/g, (_m, p: string) => `\${enc(params.${p})}`) + (spec.query ? '${qs(query)}' : '') + '`';
    const responseExpr = responseSchemaExpr(spec.response);
    const args: string[] = ['api: ApiClient'];
    if (paramsType) args.push(`params: ${paramsType}`);
    if (spec.query) args.push(`query?: z.input<typeof ${spec.query}>`);
    if (spec.body) args.push(`body: z.input<typeof ${spec.body}>`);
    const verb = spec.method === 'DELETE' ? 'del' : spec.method.toLowerCase();
    const callArgs = spec.method === 'GET' || spec.method === 'DELETE' ? `${url}, ${responseExpr}` : `${url}, ${spec.body ? 'body' : '{}'}, ${responseExpr}`;
    const doc = [`/** ${spec.method} ${spec.path} — ${spec.summary}${route.roles ? ` (roles: ${route.roles.join(', ')})` : ''}${spec.spec ? ` — ${spec.spec}` : ''}. */`];
    lines.push(...doc, `export function ${spec.operationId}(${args.join(', ')}) {`, `  return api.${verb}(${callArgs});`, '}', '');

    const hookName = `use${spec.operationId[0]!.toUpperCase()}${spec.operationId.slice(1)}`;
    if (spec.method === 'GET') {
      const hookArgs = ['api: ApiClient', ...(paramsType ? [`params: ${paramsType}`] : []), ...(spec.query ? [`query?: z.input<typeof ${spec.query}>`] : []), 'options: QueryHookOptions = {}'];
      const keyParts = [`'${spec.operationId}'`, ...(paramsType ? ['params'] : []), ...(spec.query ? ['query ?? null'] : [])];
      const fnArgs = ['api', ...(paramsType ? ['params'] : []), ...(spec.query ? ['query'] : [])];
      lines.push(`export function ${hookName}(${hookArgs.join(', ')}) {`, `  return useQuery({ queryKey: [${keyParts.join(', ')}], queryFn: () => ${spec.operationId}(${fnArgs.join(', ')}), ...options });`, '}', '');
    } else {
      const varFields = [...(paramsType ? [`params: ${paramsType}`] : []), ...(spec.body ? [`body: z.input<typeof ${spec.body}>`] : [])];
      const varsType = varFields.length ? `{ ${varFields.join('; ')} }` : 'void';
      const fnArgs = ['api', ...(paramsType ? ['vars.params'] : []), ...(spec.body ? ['vars.body'] : [])];
      lines.push(`export function ${hookName}(api: ApiClient) {`, `  return useMutation({ mutationFn: (${varFields.length ? 'vars' : '_vars'}: ${varsType}) => ${spec.operationId}(${fnArgs.join(', ')}) });`, '}', '');
    }
  }
  return lines.join('\n');
}

function responseSchemaExpr(ref: ResponseRef): string {
  if ('schema' in ref) return ref.nullable ? `${ref.schema}.nullable()` : ref.schema;
  if ('array' in ref) return `${ref.array}.array()`;
  if ('paginated' in ref) return `paginated(${ref.paginated})`;
  throw new Error('a client operation needs a JSON response schema');
}

// ---------------------------------------------------------------------------- helpers

function schemaNames(ref: ResponseRef): string[] {
  if ('schema' in ref) return [ref.schema];
  if ('array' in ref) return [ref.array];
  if ('paginated' in ref) return [ref.paginated];
  return [];
}

export function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1]!);
}

/** Duck-typed on purpose: `instanceof z.ZodType` across the schema package's unions sends tsc into TS2589. */
function isZod(value: unknown): value is z.ZodTypeAny {
  return typeof value === 'object' && value !== null && typeof (value as { safeParse?: unknown }).safeParse === 'function' && '_def' in value;
}

interface ZodDefLike {
  typeName?: string;
  shape?: () => Record<string, z.ZodTypeAny>;
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
}

function objectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  let inner: z.ZodTypeAny = schema;
  // Unwrap effects/defaults/optionals around an object, reading zod's own `_def`.
  for (let i = 0; i < 6; i += 1) {
    const def = inner._def as ZodDefLike;
    if (def.typeName === 'ZodObject' && def.shape) return def.shape();
    if (def.typeName === 'ZodEffects' && def.schema) inner = def.schema;
    else if ((def.typeName === 'ZodDefault' || def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable') && def.innerType) inner = def.innerType;
    else break;
  }
  throw new Error('query schema must be a zod object');
}

/** nestjs-zod's converter, typed loosely: its `ExtendedSchemaObject` is deep enough to trip TS2589 on our unions. */
const convert = zodV3ToOpenAPI as unknown as (schema: unknown) => unknown;
function toOpenApi(schema: unknown): Record<string, unknown> {
  return convert(schema) as Record<string, unknown>;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
