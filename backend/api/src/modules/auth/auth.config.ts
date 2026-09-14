import { Logger } from '@nestjs/common';
import { assertIssuersDiffer } from '@portal/db';

export interface NamespaceConfig {
  issuer: string;
  audience: string;
  jwksUri: string;
}

/**
 * Auth0, two tenants (ADR 0002): customers in one, staff in another with Google
 * Workspace SSO and mandatory TOTP.
 *
 * The constructor is deliberately noisy. A misconfigured issuer does not fail a
 * request — it fails *open*, by verifying a customer token against the staff JWKS —
 * so every check that can happen at boot happens at boot.
 */
export class AuthConfig {
  private readonly logger = new Logger(AuthConfig.name);

  readonly customer: NamespaceConfig;
  readonly staff: NamespaceConfig;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    // Canonicalise first, then compare. "example.auth0.com" and
    // "https://Example.auth0.com/" are the same tenant written two ways, and comparing
    // the raw env values would wave that through.
    const allowInsecure = env.NODE_ENV !== 'production' && env.APP_ENV !== 'prod';
    const customerIssuer = issuerFor(required(env, 'AUTH0_CUSTOMER_DOMAIN'), allowInsecure);
    const staffIssuer = issuerFor(required(env, 'AUTH0_STAFF_DOMAIN'), allowInsecure);

    // Two tenants or nothing: one issuer would make /admin/* accept a customer token.
    assertIssuersDiffer(customerIssuer, staffIssuer);

    this.customer = {
      issuer: customerIssuer,
      audience: required(env, 'AUTH0_CUSTOMER_AUDIENCE'),
      jwksUri: `${customerIssuer}.well-known/jwks.json`,
    };
    this.staff = {
      issuer: staffIssuer,
      audience: required(env, 'AUTH0_STAFF_AUDIENCE'),
      jwksUri: `${staffIssuer}.well-known/jwks.json`,
    };

    this.logger.log(`customer issuer ${this.customer.issuer}`);
    this.logger.log(`staff issuer    ${this.staff.issuer}`);
  }

  for(namespace: 'customer' | 'staff'): NamespaceConfig {
    return namespace === 'staff' ? this.staff : this.customer;
  }
}

/**
 * Auth0 issuers always carry the trailing slash; `iss` will not match without it.
 *
 * A bare domain — how Auth0 presents it, and how .env.example writes it — always
 * becomes https. An explicit http:// is honoured outside production so the auth tests
 * can run against a local stand-in tenant, and refused in production, where fetching a
 * JWKS over plaintext would let anyone on the path choose the signing keys.
 */
function issuerFor(domain: string, allowInsecure: boolean): string {
  const isPlaintext = /^http:\/\//i.test(domain);
  const host = domain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

  if (isPlaintext && !allowInsecure) {
    throw new Error(
      `Refusing to use the plaintext issuer "${domain}" in production. ` +
        'An Auth0 domain must be reached over https.',
    );
  }

  return `${isPlaintext ? 'http' : 'https'}://${host}/`;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. See the Auth0 section of .env.example.`);
  }
  return value;
}
