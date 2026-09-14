import { appDb } from './clients.js';

/**
 * Fails boot if DATABASE_URL is not actually RLS-enforced.
 *
 * RLS is the second guard, but it only guards if the runtime connects as something
 * that RLS applies to. A table owner, a superuser or a BYPASSRLS role reads every
 * workspace and the policies say nothing — and the symptom of that mistake is silent
 * cross-tenant data, discovered by a customer. So we check it on every boot instead.
 */
export async function assertRlsEnforced(): Promise<void> {
  const [probe] = await appDb.$queryRaw<
    {
      current_user: string;
      is_superuser: boolean;
      bypasses_rls: boolean;
      in_portal_app: boolean;
      owns_tenants: boolean;
      rls_tables: bigint;
    }[]
  >`
    SELECT
      current_user                                              AS current_user,
      (SELECT rolsuper     FROM pg_roles WHERE rolname = current_user) AS is_superuser,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls,
      pg_has_role(current_user, 'portal_app', 'member')          AS in_portal_app,
      pg_catalog.pg_get_userbyid(c.relowner) = current_user      AS owns_tenants,
      (SELECT count(*) FROM pg_class
        WHERE relrowsecurity AND relnamespace = 'public'::regnamespace) AS rls_tables
    FROM pg_class c
    WHERE c.oid = 'public.tenants'::regclass
  `;

  if (!probe) {
    throw new Error('Could not probe public.tenants — are the migrations applied?');
  }

  const complaints: string[] = [];
  if (probe.rls_tables === 0n) complaints.push('no table has RLS enabled — migrations are behind');
  if (probe.is_superuser) complaints.push('the role is a superuser');
  if (probe.bypasses_rls) complaints.push('the role has BYPASSRLS');
  if (probe.owns_tenants) complaints.push('the role owns the tables, and owners skip RLS');
  if (!probe.in_portal_app) complaints.push('the role is not a member of portal_app');

  if (complaints.length > 0) {
    throw new Error(
      `DATABASE_URL connects as "${probe.current_user}", which is not RLS-enforced: ` +
        `${complaints.join('; ')}. Point it at a portal_app member ` +
        `(locally: pnpm db:roles) and keep the owner for DIRECT_DATABASE_URL.`,
    );
  }
}

/**
 * Fails boot if the two Auth0 tenants have been collapsed into one.
 *
 * Staff and customers authenticate against separate Auth0 tenants (ADR 0002). If they
 * ever share an issuer, a customer token verifies on /admin/* and the whole staff
 * boundary is decorative. Cheap to check, catastrophic to miss.
 */
export function assertIssuersDiffer(customerIssuer: string, staffIssuer: string): void {
  // Compare the way Postgres would compare hostnames: case-insensitive, scheme and
  // trailing slash stripped, so two spellings of one tenant still collide.
  const normalise = (i: string) =>
    i
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
  if (!customerIssuer || !staffIssuer) {
    throw new Error('Both AUTH0_CUSTOMER_DOMAIN and AUTH0_STAFF_DOMAIN must be set.');
  }
  if (normalise(customerIssuer) === normalise(staffIssuer)) {
    throw new Error(
      `The customer and staff Auth0 issuers are identical (${customerIssuer}). ` +
        'They must be two separate tenants (ADR 0002), or a customer token would be ' +
        'accepted on /admin/*.',
    );
  }
}
