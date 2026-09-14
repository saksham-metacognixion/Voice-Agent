import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { CLAIM_EMAIL_VERIFIED, CLAIM_MFA } from '@portal/schemas';

/**
 * A stand-in Auth0 tenant: an RS256 key pair and a JWKS endpoint on localhost.
 *
 * Two of these are what make the "customer JWT is rejected on /admin/*" test mean
 * something. They are genuinely separate issuers with genuinely different keys, so the
 * test exercises the same signature and issuer checks production does — no stubbing of
 * the verifier, which is the part most worth trusting.
 */
export class FakeAuth0Tenant {
  private server?: Server;
  private privateKey!: CryptoKey;
  private jwk!: JWK;

  constructor(
    readonly name: string,
    readonly audience: string,
  ) {}

  /**
   * What AUTH0_*_DOMAIN is set to. Plaintext, which AuthConfig accepts outside
   * production precisely so a local stand-in tenant like this one can be used.
   */
  get domain(): string {
    const address = this.server?.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  get issuer(): string {
    return `${this.domain}/`;
  }

  async start(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    this.privateKey = privateKey;
    this.jwk = {
      ...(await exportJWK(publicKey)),
      kid: `${this.name}-key`,
      alg: 'RS256',
      use: 'sig',
    };

    this.server = createServer((req, res) => {
      if (req.url?.startsWith('/.well-known/jwks.json')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [this.jwk] }));
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  async mint(
    subject: string,
    claims: { emailVerified?: boolean; mfa?: boolean; audience?: string; expired?: boolean } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      [CLAIM_EMAIL_VERIFIED]: claims.emailVerified ?? true,
      [CLAIM_MFA]: claims.mfa ?? false,
      email: `${subject.replace(/[^a-z0-9]/gi, '')}@example.test`,
    })
      .setProtectedHeader({ alg: 'RS256', kid: this.jwk.kid })
      .setSubject(subject)
      .setIssuer(this.issuer)
      .setAudience(claims.audience ?? this.audience)
      .setIssuedAt(claims.expired ? now - 7200 : now)
      .setExpirationTime(claims.expired ? now - 3600 : now + 3600)
      .sign(this.privateKey);
  }
}
