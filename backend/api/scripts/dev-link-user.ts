/**
 * Dev only: link an Auth0 token to a local account so Postman can call the customer API.
 *
 *   pnpm --filter @portal/api exec dotenv -e ../../.env -- tsx scripts/dev-link-user.ts <jwt|sub> [workspace_id]
 *
 * Takes either the access token (reveal it in Postman's token dialog) or the Auth0 user id
 * straight from User Management → Users, which is the same string as the token's `sub`.
 *
 * Why it exists: the API resolves a caller by `users.auth_provider_id = <jwt sub>` and
 * refuses a token with no row behind it (401 UNAUTHENTICATED). That row is normally
 * written by the Auth0 Post-User-Registration Action → POST /webhooks/auth, which lands
 * with `workspaces` on D5. Until then this does the same thing by hand.
 *
 * The JWT is only *decoded*, never verified — the real verification happens in the API
 * against the JWKS. So this must never run anywhere but dev, and it refuses to.
 */
import 'reflect-metadata';
import { adminDb, disconnect } from '@portal/db';
import { isDevEnv } from '../src/common/env';
import { PlatformConfigService } from '../src/modules/config';
import { RedisCache, closeRedis, createRedisClient, waitForRedis } from '../src/modules/redis';
import { WalletService } from '../src/modules/wallet';

type Claims = { sub?: string; email?: string; [k: string]: unknown };

/**
 * Accepts a JWT or a bare Auth0 user id. A JWT is three dot-separated base64url parts;
 * a subject is `auth0|…`, `google-oauth2|…` or `<client_id>@clients`. Anything that is
 * not obviously a JWT is treated as a subject, so a copy-paste of the wrong half of the
 * screen fails with a clear message instead of a base64 error.
 */
function claimsOf(argument: string): Claims {
  const value = argument.trim().replace(/^Bearer\s+/i, '');
  const parts = value.split('.');
  if (parts.length !== 3) {
    if (!/^[^|\s]+[|@][^\s]+$/.test(value)) {
      throw new Error(`"${value.slice(0, 40)}" is neither a JWT nor an Auth0 subject (auth0|… or …@clients).`);
    }
    return { sub: value };
  }
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Claims;
  } catch {
    throw new Error('That looks like a JWT but its payload will not decode. Copy the whole Access Token.');
  }
}

async function main() {
  if (!isDevEnv()) throw new Error(`This script only runs with APP_ENV=dev (got ${process.env.APP_ENV ?? 'unset'}).`);

  const [credential, workspaceArg] = process.argv.slice(2);
  if (!credential) throw new Error('Usage: tsx scripts/dev-link-user.ts <jwt|sub> [workspace_id]');

  const payload = claimsOf(credential);
  const sub = payload.sub;
  if (!sub) throw new Error('The token carries no `sub` claim.');
  const email = typeof payload.email === 'string' ? payload.email : `${sub.replace(/[^a-z0-9]/gi, '-')}@dev.local`;

  const user = await adminDb.user.upsert({
    where: { authProviderId: sub },
    create: { authProviderId: sub, email, name: 'Postman' },
    update: { email },
    select: { id: true, email: true },
  });

  // Reuse the workspace the caller named, else one they already belong to, else make one.
  let workspaceId = workspaceArg;
  if (!workspaceId) {
    const existing = await adminDb.membership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { tenantId: true },
    });
    workspaceId = existing?.tenantId;
  }
  let created = false;
  if (!workspaceId) {
    const tenant = await adminDb.tenant.create({ data: { name: 'Postman test', country: 'CA' } });
    workspaceId = tenant.id;
    created = true;
  }

  await adminDb.membership.upsert({
    where: { tenantId_userId: { tenantId: workspaceId, userId: user.id } },
    create: { tenantId: workspaceId, userId: user.id, role: 'owner' },
    update: {},
  });

  // A brand new workspace with no credits makes every wallet screen look broken, so give
  // it the §5.4 trial grant — the same call sign-up will make on D5.
  const redis = createRedisClient(process.env.REDIS_URL);
  await waitForRedis(redis);
  const cache = new RedisCache(redis);
  const wallet = new WalletService(cache, new PlatformConfigService(cache));
  if (created) await wallet.grantTrial(workspaceId);
  const balance = await wallet.balance(workspaceId);

  console.log(
    JSON.stringify(
      {
        user_id: user.id,
        email: user.email,
        sub,
        email_verified_claim: payload['https://portal/email_verified'] === true,
        workspace_id: workspaceId,
        workspace_created: created,
        balance,
        postman_headers: { Authorization: 'Bearer <this token>', 'X-Workspace-Id': workspaceId },
      },
      null,
      2,
    ),
  );
  if (payload['https://portal/email_verified'] !== true) {
    console.log(
      '\nNote: this run saw no https://portal/email_verified claim' +
        (payload.iss ? '' : ' (you passed a subject, not a token, so there were no claims to read)') +
        '. POST /wallet/checkout answers 403 EMAIL_UNVERIFIED until the signed-in user has confirmed their email; every other D3 route works either way.',
    );
  }

  await closeRedis(redis);
  await disconnect();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await disconnect().catch(() => undefined);
  process.exit(1);
});
