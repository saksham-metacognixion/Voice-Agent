/**
 * OpenAPI + typed client generator (D7).
 *
 *   pnpm --filter @portal/api openapi:generate     write docs/api/openapi.json and
 *                                                  frontend/api-client/src/generated/endpoints.ts
 *   pnpm --filter @portal/api openapi:check        regenerate in memory and fail if either
 *                                                  file on disk differs (the CI gate)
 *
 * Routes come from the controllers' decorator metadata (no DI container is booted, so this
 * runs under tsx); everything else comes from `src/openapi/manifest.ts`. A route in one
 * and not the other is a hard error — that is what keeps the document current.
 */
import 'reflect-metadata';
import '@portal/config/vitest/load-env';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CONTROLLERS } from '../src/openapi/controllers';
import { discoverRoutes } from '../src/openapi/discover';
import { buildClient, buildOpenApi, join } from '../src/openapi/generate';

const ROOT = resolve(process.cwd(), '../..');
const OPENAPI_OUT = resolve(ROOT, 'docs/api/openapi.json');
const CLIENT_OUT = resolve(ROOT, 'frontend/api-client/src/generated/endpoints.ts');

function main(): void {
  const check = process.argv.includes('--check');
  const version = (JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;

  const routes = discoverRoutes(CONTROLLERS as unknown as (new (...args: never[]) => unknown)[]);
  const joined = join(routes);
  const openapi = `${JSON.stringify(buildOpenApi(joined, version), null, 2)}\n`;
  const client = `${buildClient(joined)}\n`;

  const outputs: Array<[string, string]> = [
    [OPENAPI_OUT, openapi],
    [CLIENT_OUT, client],
  ];
  if (check) {
    const stale = outputs.filter(([path, content]) => !existsSync(path) || readFileSync(path, 'utf8') !== content).map(([path]) => path.replace(`${ROOT}/`, ''));
    if (stale.length) {
      console.error(`OpenAPI artefacts are stale: ${stale.join(', ')}. Run: pnpm --filter @portal/api openapi:generate`);
      process.exit(1);
    }
    console.log(`OpenAPI is current: ${joined.length} operations, ${outputs.length} files match.`);
    return;
  }
  for (const [path, content] of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    console.log(`wrote ${path.replace(`${ROOT}/`, '')}`);
  }
  console.log(`${joined.length} operations across ${new Set(joined.map((j) => j.spec.tag)).size} tags.`);
}

main();
