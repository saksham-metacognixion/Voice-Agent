/**
 * Dev only: the fixtures `frontend/web/scripts/e2e-auth-d20.mjs` signs in as (ADR 0036).
 *
 *   pnpm --filter @portal/api exec dotenv -e ../../.env -- tsx scripts/e2e-d20-seed.ts
 *
 * Prints JSON: an owner who has not accepted the Terms, with a live workspace that has auto
 * top-up on (the MFA banner) and a second, live workspace where they are a viewer with a
 * different balance (the switcher pill, the viewer redirect); an open invite for another
 * address (the sign-in pre-fill); a person with no workspace who has accepted the Terms
 * (the A3 country list); and an address that is not verified (A2). Credits go through the
 * wallet like any grant. Nothing is sent anywhere.
 */
import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type Prisma, adminDb, disconnect } from '@portal/db';
import { TERMS_VERSION } from '@portal/schemas';
import { isDevEnv } from '../src/common/env';
import { PlatformConfigService } from '../src/modules/config';
import { RedisCache, closeRedis, createRedisClient, waitForRedis } from '../src/modules/redis';
import { WalletService, addMonths } from '../src/modules/wallet/wallet.service';

async function main() {
  if (!isDevEnv()) throw new Error(`This script only runs with APP_ENV=dev (got ${process.env.APP_ENV ?? 'unset'}).`);
  const run = randomUUID().slice(0, 8);
  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);
  const cache = new RedisCache(redis);
  const wallet = new WalletService(cache, new PlatformConfigService(cache));

  const person = async (label: string, terms: boolean) => {
    const sub = `auth0|d20-${label}-${run}`;
    const email = `d20-${label}-${run}@example.test`;
    const user = await adminDb.user.create({ data: { authProviderId: sub, email, name: `D20 ${label}`, ...(terms ? { tosVersion: TERMS_VERSION, tosAcceptedAt: new Date() } : {}) } });
    return { sub, email, name: `D20 ${label}`, id: user.id };
  };
  const liveWorkspace = async (name: string, credits: number, autoTopup: boolean) => {
    const tenant = await adminDb.tenant.create({
      data: {
        name,
        country: 'CA',
        timezone: 'America/Toronto',
        onboardingCompletedAt: new Date(),
        onboardingStep: 7,
        ...(autoTopup ? { autoTopupJson: { enabled: true, pack_id: 'growth', threshold: 50, payment_method_id: 'pm_d20_seed', card_last4: '4242' } as Prisma.InputJsonValue } : {}),
      },
    });
    await adminDb.notificationSetting.create({ data: { tenantId: tenant.id, userId: null } });
    await wallet.grant(tenant.id, { credits, reason: 'adjustment', expiresAt: addMonths(new Date(), 12), refType: 'seed', refId: randomUUID() });
    return tenant.id;
  };

  const owner = await person('owner', false);
  const topupWs = await liveWorkspace(`D20 Bakery ${run}`, 50, true);
  const viewerWs = await liveWorkspace(`D20 Clinic ${run}`, 1234.5, false);
  await adminDb.membership.create({ data: { tenantId: topupWs, userId: owner.id, role: 'owner' } });
  const clinicOwner = await person('clinic-owner', true);
  await adminDb.membership.create({ data: { tenantId: viewerWs, userId: clinicOwner.id, role: 'owner' } });
  await adminDb.membership.create({ data: { tenantId: viewerWs, userId: owner.id, role: 'viewer' } });

  const token = randomBytes(32).toString('base64url');
  const invitee = `d20-invitee-${run}@example.test`;
  await adminDb.invite.create({
    data: { tenantId: topupWs, email: invitee, role: 'editor', tokenHash: createHash('sha256').update(token).digest('hex'), invitedBy: owner.id, expiresAt: new Date(Date.now() + 86_400_000) },
  });

  const newcomer = await person('newcomer', true);
  const unverified = await person('unverified', true);

  console.log(JSON.stringify({ run, owner, topupWs, viewerWs, invite: { token, email: invitee }, newcomer, unverified }));
  await closeRedis(redis);
  await disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnect().catch(() => undefined);
  process.exit(1);
});
