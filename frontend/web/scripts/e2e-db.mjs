/**
 * Dev-only helper for the dashboard e2e: a staff announcement row for the D1 banner
 * (SA10 has no console yet — D20 — so the row is written straight to the table and
 * removed after the check). Uses the API's own `@portal/db` client on `adminDb`;
 * reads ADMIN_DATABASE_URL / DATABASE_URL from the environment, else the repo-root .env.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

function loadEnv() {
  if (process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL) return;
  const env = readFileSync(fileURLToPath(new URL('../../../.env', import.meta.url)), 'utf8');
  for (const key of ['ADMIN_DATABASE_URL', 'DATABASE_URL', 'DIRECT_DATABASE_URL']) {
    const line = env.split('\n').find((l) => l.startsWith(`${key}=`));
    if (line && !process.env[key]) process.env[key] = line.slice(key.length + 1).trim().replace(/\s+#.*$/, '').replace(/^"|"$/g, '');
  }
}

function db() {
  loadEnv();
  const mod = require(fileURLToPath(new URL('../../../backend/db/dist/index.js', import.meta.url)));
  return mod.adminDb;
}

/** Creates a banner announcement, runs `fn`, deletes the row whatever happens. */
export async function withAnnouncement({ body, severity = 'info', audience = null, dismissible = true }, fn) {
  const adminDb = db();
  const row = await adminDb.announcement.create({ data: { type: 'banner', body, severity, audienceJson: audience, dismissible } });
  try {
    return await fn(row);
  } finally {
    await adminDb.announcement.delete({ where: { id: row.id } }).catch(() => null);
    await adminDb.$disconnect().catch(() => null);
  }
}
