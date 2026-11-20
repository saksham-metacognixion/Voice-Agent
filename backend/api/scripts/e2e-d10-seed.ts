/**
 * Dev only: the fixture `frontend/web/scripts/e2e-dashboard.mjs` drives (D10, D11, and the
 * D1 rows of ADR 0041) — a live, paid workspace whose owner the stand-in issuer mints, a
 * restaurant agent created and published through the real API (so the D3 publish is a
 * real platform sync), seven versions with the draft ahead, and sixty `d10seed_*` calls
 * over the last 30 days: analysed phone calls with the captured fields the D2 drawer
 * lists, missed ones, two of today with a message taken, and one recorded website call
 * whose recording is a clip the export serves.
 *
 *   ISSUER_URL=http://localhost:9999 API_URL=http://localhost:4001 PORTAL_URL=http://localhost:3005 \
 *   E2E_USER_FILE=/tmp/e2e-user.json \
 *   pnpm --filter @portal/api exec dotenv -e ../../.env -- tsx scripts/e2e-d10-seed.ts
 *
 * Writes the owner's identity into E2E_USER_FILE first (the issuer reads it on every
 * token), then needs the API at API_URL bound to that issuer. Prints JSON. Nothing is
 * sent anywhere but the voice platform, which gets one `dev-` prefixed agent.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, adminDb } from '@portal/db';
import { TERMS_VERSION } from '@portal/schemas';
import { isDevEnv } from '../src/common/env/app-env';

const ISSUER = (process.env.ISSUER_URL ?? 'http://localhost:9999').replace(/\/+$/, '');
const API = (process.env.API_URL ?? 'http://localhost:4001').replace(/\/+$/, '');
const PORTAL = (process.env.PORTAL_URL ?? 'http://localhost:3005').replace(/\/+$/, '');
const USER_FILE = process.env.E2E_USER_FILE;

const PROMPT = [
  '## Identity',
  'You are Marie, the friendly host for Bright Smile Health, a family clinic in Toronto.',
  '',
  '## Goal',
  'Answer calls, share opening hours (Monday to Friday, 9am to 5pm), take reservations and detailed messages for the team including the caller name and callback number.',
  '',
  '## Style',
  'Warm, concise, professional. Confirm details back to the caller. Never give medical advice.',
  '',
  '## Hand-off',
  'If the caller is in pain, take a message marked urgent and promise a callback within the hour.',
].join('\n');

const BRIEF = {
  about_business: 'A family clinic in Toronto with two practitioners and a small dining room for events.',
  goal: 'Answer calls, share opening hours, take table reservations and detailed messages for the team.',
  services: ['Check-ups', 'Reservations'],
  agent_name: 'Marie',
  address: '120 Queen St W, Toronto, ON',
};

async function token(audience: string): Promise<string> {
  const state = randomUUID();
  const authorize = await fetch(`${ISSUER}/authorize?client_id=e2e&redirect_uri=${encodeURIComponent('http://localhost/cb')}&audience=${encodeURIComponent(audience)}&state=${state}`, { redirect: 'manual' });
  const location = authorize.headers.get('location') ?? '';
  const code = new URL(location, 'http://localhost').searchParams.get('code');
  if (!code) throw new Error(`issuer gave no code: ${authorize.status} ${location}`);
  const res = await fetch(`${ISSUER}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'authorization_code', code }) });
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`issuer gave no token: ${res.status}`);
  return body.access_token;
}

async function main() {
  if (!isDevEnv()) throw new Error(`This script only runs with APP_ENV=dev (got ${process.env.APP_ENV ?? 'unset'}).`);
  if (!USER_FILE) throw new Error('E2E_USER_FILE is required (the issuer reads the same file).');
  const audience = process.env.AUTH0_CUSTOMER_AUDIENCE;
  if (!audience) throw new Error('AUTH0_CUSTOMER_AUDIENCE is not set.');
  const run = randomUUID().slice(0, 8);

  // 1. The owner, and the identity the issuer will mint from now on.
  const sub = `auth0|d10-${run}`;
  const email = `d10-${run}@example.test`;
  const user = await adminDb.user.create({ data: { authProviderId: sub, email, name: 'D10 Owner', tosVersion: TERMS_VERSION, tosAcceptedAt: new Date() } });
  writeFileSync(USER_FILE, JSON.stringify({ sub, email, name: 'D10 Owner', email_verified: true }));

  // 2. The workspace, live, with the §15 default notification row.
  const tenant = await adminDb.tenant.create({ data: { name: 'Bright Smile Health', country: 'CA', timezone: 'America/Toronto', onboardingStep: 7, onboardingCompletedAt: new Date() } });
  await adminDb.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: 'owner' } });
  await adminDb.notificationSetting.create({ data: { tenantId: tenant.id, userId: null } });
  // Paid Growth through the same seed W7 stands in for (caps and credits from the pricing config).
  execSync(`pnpm --filter @portal/api dev:seed-workspace ${tenant.id} growth --live`, { cwd: join(__dirname, '..', '..', '..'), stdio: 'ignore' });

  // 3. The agent through the API: created, briefed, scripted, published (real platform sync), then versioned.
  const bearer = await token(audience);
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'x-workspace-id': tenant.id, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return json;
  };
  const created = await api('POST', '/agents', { template_id: 'restaurant', industry: 'restaurant', name: 'Restaurant Reservations' });
  const agentId = created.id as string;
  await api('PATCH', `/agents/${agentId}/draft`, { brief: BRIEF });
  await api('PUT', `/agents/${agentId}/versions/1/prompt`, { prompt: PROMPT, greeting: 'Thanks for calling Bright Smile Health, this is Marie. How can I help you today?' });
  await api('POST', `/agents/${agentId}/publish`, {});
  // Seven versions, the draft ahead of the live one with a script: the D3 versions table and the §7.2 chip.
  for (let i = 2; i <= 6; i += 1) {
    await api('PUT', `/agents/${agentId}/versions/${i}/prompt`, { prompt: `${PROMPT}\n\nRevision ${i}: confirm the reservation time back to the caller.` }).catch(async () => {
      const detail = (await api('GET', `/agents/${agentId}`)) as { draft?: { version_no: number } };
      await api('PUT', `/agents/${agentId}/versions/${detail.draft?.version_no ?? i}/prompt`, { prompt: `${PROMPT}\n\nRevision ${i}: confirm the reservation time back to the caller.` });
    });
    await api('POST', `/agents/${agentId}/versions`, {});
  }

  // 4. Sixty calls over the last 30 days.
  const now = Date.now();
  const callers = ['+14165550101', '+14165550102', '+16475550103', '+14505550104', '+14165550105', '+15145550106'];
  const reasons = ['Appointment request', 'Hours question', 'Reservation', 'Message taken'];
  const sentiments = ['Positive', 'Positive', 'Positive', 'Neutral', 'Negative'];
  const rows: Prisma.CallUncheckedCreateInput[] = [];
  const transcript = (name: string) => [
    { role: 'agent', content: 'Thanks for calling Bright Smile Health, this is Marie. How can I help you today?' },
    { role: 'user', content: `Hi, this is ${name}. I would like to book a table for four on Friday at seven.` },
    { role: 'agent', content: 'Of course. A table for four, Friday at seven. May I have a callback number?' },
    { role: 'user', content: 'Sure, 416 555 0101.' },
    { role: 'agent', content: 'Thank you. You are booked. Is there anything else I can help with?' },
    { role: 'user', content: 'No, that is all. Thanks!' },
  ];
  for (let n = 0; n < 60; n += 1) {
    const daysAgo = n < 2 ? 0 : (n * 7) % 30;
    const startedAt = new Date(now - daysAgo * 86_400_000 - ((n * 37) % 600) * 60_000 - 3_600_000);
    const id = `d10seed_${run}_${String(n).padStart(2, '0')}`;
    const from = callers[n % callers.length]!;
    if (n % 6 === 5) {
      rows.push({ id, tenantId: tenant.id, agentId, agentVersion: 1, channel: 'phone', direction: 'inbound', fromNumber: from, toNumber: '+14165550100', startedAt, status: 'declined', declineReason: (['balance', 'cap', 'hours'] as const)[n % 3], creditsCharged: 0 });
      continue;
    }
    const seconds = 20 + ((n * 53) % 380);
    const name = ['Anna Lee', 'Omar Haddad', 'Chloé Martin', 'Devon Price'][n % 4]!;
    const messageTaken = n % 3 === 0;
    const turns = transcript(name);
    rows.push({
      id,
      tenantId: tenant.id,
      agentId,
      agentVersion: 1,
      channel: n === 1 ? 'web' : 'phone',
      direction: 'inbound',
      isTest: false,
      fromNumber: n === 1 ? null : from,
      toNumber: '+14165550100',
      startedAt,
      endedAt: new Date(startedAt.getTime() + seconds * 1000),
      durationS: seconds,
      creditsCharged: new Prisma.Decimal((seconds / 60).toFixed(2)),
      status: 'analyzed',
      outcome: reasons[n % reasons.length]!,
      handledAt: n % 4 === 0 ? new Date(startedAt.getTime() + 7_200_000) : null,
      transcriptText: turns.map((t) => `${t.role === 'agent' ? 'Agent' : 'User'}: ${t.content}`).join('\n'),
      transcriptJson: turns as unknown as Prisma.InputJsonValue,
      recordingUrl: n === 1 ? `${PORTAL}/samples/voices/${readdirSync(join(__dirname, '..', '..', '..', 'frontend', 'web', 'public', 'samples', 'voices')).find((f) => f.endsWith('.mp3'))}` : null,
      analysisJson: {
        call_summary: `${name} asked to book a table for four on Friday at 7 pm and left a callback number.`,
        user_sentiment: sentiments[n % sentiments.length],
        call_successful: true,
        custom_analysis_data: {
          'Customer name': name,
          'Party size': 4,
          call_reason: reasons[n % reasons.length],
          message_taken: messageTaken,
          callback_number: messageTaken ? '+1 416 555 0101' : '',
        },
      } as Prisma.InputJsonValue,
    });
  }
  await adminDb.call.createMany({ data: rows });

  console.log(JSON.stringify({ sub, email, workspaceId: tenant.id, agentId, calls: rows.length, userFile: USER_FILE }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => adminDb.$disconnect());
