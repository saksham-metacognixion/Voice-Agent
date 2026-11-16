/* eslint-disable no-console */
/**
 * QA-106 (ADR 0044): the workspaces with a hand-off target or a blocked caller saved
 * without its country code before the rule, for support to contact. The portal shows the
 * same customers "Some phone numbers need fixing"; this is the list for the ones who do
 * not open it. Read-only: it changes nothing, and nothing is corrected automatically —
 * the suggested number is a reading of the digits in the number's country (else the
 * workspace's), for the customer to confirm.
 *
 *   pnpm --filter @portal/api numbers:needing-fix            # a table
 *   pnpm --filter @portal/api numbers:needing-fix --csv      # CSV on stdout
 *
 * Hand-off: every target that is not a real number (it is dialled). Blocked callers:
 * only entries that read as a national number given a `+` — a caller ID that is simply
 * not a real number is allowed on the list.
 */
import { adminDb, disconnect } from '@portal/db';
import { isDialableE164, nationalReading } from '@portal/schemas';

interface Finding {
  workspace_id: string;
  workspace: string;
  owner_email: string;
  number: string;
  list: 'hand-off' | 'blocked callers';
  saved: string;
  probably_meant: string;
}

function csvCell(value: string): string {
  // Formula-safe, like the portal's exports: a cell never starts with = + - @.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function main() {
  const csv = process.argv.includes('--csv');
  const rows = await adminDb.phoneNumber.findMany({
    where: { status: { notIn: ['released', 'releasing'] } },
    select: {
      id: true, e164: true, country: true, blocklist: true, transferTargetsJson: true,
      tenant: { select: { id: true, name: true, country: true, memberships: { where: { role: 'owner' }, select: { user: { select: { email: true } } }, take: 1 } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const findings: Finding[] = [];
  for (const row of rows) {
    const country = row.country ?? row.tenant.country;
    const base = { workspace_id: row.tenant.id, workspace: row.tenant.name, owner_email: row.tenant.memberships[0]?.user.email ?? '', number: row.e164 ?? row.id };
    const targets = Array.isArray(row.transferTargetsJson) ? row.transferTargetsJson : [];
    for (const target of targets) {
      const number = target && typeof target === 'object' && !Array.isArray(target) ? (target as Record<string, unknown>).number : null;
      if (typeof number !== 'string' || isDialableE164(number)) continue;
      findings.push({ ...base, list: 'hand-off', saved: number, probably_meant: nationalReading(number, country) ?? '' });
    }
    for (const entry of row.blocklist) {
      const meant = nationalReading(entry.trim(), country);
      if (meant) findings.push({ ...base, list: 'blocked callers', saved: entry, probably_meant: meant });
    }
  }

  if (csv) {
    const columns: Array<keyof Finding> = ['workspace_id', 'workspace', 'owner_email', 'number', 'list', 'saved', 'probably_meant'];
    console.log(columns.join(','));
    for (const f of findings) console.log(columns.map((c) => csvCell(f[c])).join(','));
    return;
  }
  const workspaces = new Set(findings.map((f) => f.workspace_id)).size;
  console.log(`${findings.length} entr${findings.length === 1 ? 'y' : 'ies'} in ${workspaces} workspace(s), ${rows.length} number(s) read`);
  if (findings.length) console.table(findings);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void disconnect());
