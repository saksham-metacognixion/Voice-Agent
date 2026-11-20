import { readFileSync } from 'node:fs';

/**
 * Reads a .env file into process.env without adding a dependency. Values already in the
 * environment win, so a CI variable is never overwritten by a checked-out file.
 *
 * Shared by `pnpm doctor` and `pnpm auth0:*` — two readers of the same file that must not
 * disagree about what "unset" means.
 */
export function loadEnvFile(path) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return; // Deployed environments inject real environment variables instead.
  }
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    // dotenv's rules for an unquoted value: everything up to an unquoted '#'. A value
    // that is nothing but a comment — how .env.example documents an unset key — is empty.
    const quoted = /^\s*(['"`])([\s\S]*?)\1\s*$/.exec(raw);
    process.env[key] = quoted ? quoted[2] : raw.split('#')[0].trim();
  }
}
