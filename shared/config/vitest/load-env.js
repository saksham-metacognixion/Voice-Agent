/**
 * Vitest setup file: makes the root .env available to tests that need a database.
 *
 * Referenced as `setupFiles` by the e2e configs. Locally it picks up the developer's
 * .env; in CI there is no such file and the workflow's `env:` block has already put the
 * same keys in the environment, so this is a no-op. Either way the test command is just
 * `vitest run` — no dotenv-cli wrapper that would fail when the file is absent.
 *
 * Real environment variables always win, so `DATABASE_URL=… pnpm test:e2e` still works.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let contents;
try {
  contents = readFileSync(resolve(repoRoot, '.env'), 'utf8');
} catch {
  contents = '';
}

for (const line of contents.split('\n')) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!match) continue;
  const [, key, raw] = match;
  if (process.env[key] !== undefined) continue;

  // dotenv's rules for an unquoted value: up to the first unquoted '#'. A value that is
  // nothing but a comment — how .env.example documents an unset key — is empty.
  const quoted = /^\s*(['"`])([\s\S]*?)\1\s*$/.exec(raw);
  const value = quoted ? quoted[2] : raw.split('#')[0].trim();
  if (value) process.env[key] = value;
}
