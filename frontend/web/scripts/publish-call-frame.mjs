/**
 * Dev-only helper for the dashboard e2e: publishes one SSE frame on a workspace's
 * `events:{ws}` channel exactly as `EventsService.publish` does, so the browser's stream
 * receives it through the API's subscriber. Reads REDIS_URL from the repo-root .env.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function redisUrl() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const env = readFileSync(fileURLToPath(new URL('../../../.env', import.meta.url)), 'utf8');
  const line = env.split('\n').find((l) => l.startsWith('REDIS_URL='));
  return (line ?? 'REDIS_URL=redis://localhost:6379').slice('REDIS_URL='.length).trim().replace(/\s+#.*$/, '');
}
export async function publishCallFrame(workspaceId, callId, type, data) {
  const Redis = require(fileURLToPath(new URL('../../../backend/api/node_modules/ioredis/built/index.js', import.meta.url))).default;
  const client = new Redis(redisUrl());
  const event = { id: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`, topic: `call:${callId}`, type, ts: new Date().toISOString(), data };
  await client.publish(`events:{${workspaceId}}`, JSON.stringify(event));
  await client.quit();
  return event;
}
