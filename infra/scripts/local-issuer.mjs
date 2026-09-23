#!/usr/bin/env node
/**
 * A stand-in OIDC issuer for local development and the wizard end-to-end run (ADR 0017).
 *
 * The API accepts a plaintext `http://` issuer outside production (`issuerFor` in
 * modules/auth/auth.config.ts), and @auth0/auth0-spa-js accepts a domain that carries its
 * own scheme, so this one process replaces Auth0 on a dev box: /authorize answers at once
 * with a code (no form), /oauth/token signs RS256 tokens with the claims the API expects
 * (`https://portal/email_verified`, `/email`, `/name`), and /.well-known/jwks.json serves
 * the key. PKCE is verified for real. Nothing here is usable in staging or prod.
 *
 *   pnpm dev:issuer                                    # http://localhost:9999
 *   API:    AUTH0_CUSTOMER_DOMAIN=http://localhost:9999 (plus the usual .env)
 *   Portal: NEXT_PUBLIC_AUTH0_DOMAIN=http://localhost:9999 pnpm --filter @portal/web build
 *
 * The signed-in identity is LOCAL_ISSUER_SUB / _EMAIL / _NAME / _EMAIL_VERIFIED, or a JSON
 * file named by LOCAL_ISSUER_USER_FILE (re-read on every request, so a test can switch
 * user without a restart).
 */
import { createServer } from 'node:http';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
const port = Number(process.env.LOCAL_ISSUER_PORT ?? 9999);
const issuer = `http://localhost:${port}/`;
const userFile = process.env.LOCAL_ISSUER_USER_FILE;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'local-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');
const sign = (payload) => { const head = b64({ alg: 'RS256', typ: 'JWT', kid }); const body = b64(payload); const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey).toString('base64url'); return `${head}.${body}.${sig}`; };
const envUser = () => ({
  sub: process.env.LOCAL_ISSUER_SUB ?? 'auth0|local-dev-user',
  email: process.env.LOCAL_ISSUER_EMAIL ?? 'dev@example.test',
  name: process.env.LOCAL_ISSUER_NAME ?? 'Local Dev',
  email_verified: process.env.LOCAL_ISSUER_EMAIL_VERIFIED !== 'false',
});
const user = () => (userFile ? JSON.parse(readFileSync(userFile, 'utf8')) : envUser());
const codes = new Map(); const refreshTokens = new Map();
const readBody = (req) => new Promise((r) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => r(d)); });
const parseBody = (raw, type) => (type?.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw)));
const now = () => Math.floor(Date.now() / 1000);
function tokens({ nonce, audience, clientId, mfa }) {
  const u = user(); const iat = now();
  const access = sign({ iss: issuer, sub: u.sub, aud: [audience], iat, exp: iat + 3600, scope: 'openid profile email offline_access', azp: clientId, 'https://portal/email_verified': u.email_verified !== false, 'https://portal/email': u.email, 'https://portal/name': u.name });
  const id = sign({ iss: issuer, sub: u.sub, aud: clientId, iat, exp: iat + 3600, ...(nonce ? { nonce } : {}), email: u.email, email_verified: u.email_verified !== false, name: u.name, picture: u.picture ?? null, amr: mfa ? ['mfa', 'pwd'] : ['pwd'] });
  const refresh = randomBytes(24).toString('base64url'); refreshTokens.set(refresh, { audience, clientId, mfa });
  return { access_token: access, id_token: id, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email offline_access' };
}
createServer(async (req, res) => {
  const url = new URL(req.url, issuer); const q = url.searchParams;
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' }); res.end(JSON.stringify(body)); };
  if (req.method === 'OPTIONS') return json(204, {});
  if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer, jwks_uri: `${issuer}.well-known/jwks.json`, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}oauth/token`, end_session_endpoint: `${issuer}v2/logout` });
  if (url.pathname === '/.well-known/jwks.json') return json(200, { keys: [jwk] });
  if (url.pathname === '/authorize') {
    const code = randomBytes(16).toString('base64url');
    codes.set(code, { nonce: q.get('nonce'), challenge: q.get('code_challenge'), audience: q.get('audience'), clientId: q.get('client_id'), mfa: (q.get('acr_values') ?? '').includes('multi-factor'), screen: q.get('screen_hint') });
    console.log(`authorize screen=${q.get('screen_hint') ?? 'login'} mfa=${codes.get(code).mfa} redirect=${q.get('redirect_uri')}`);
    res.writeHead(302, { location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state') ?? '')}` }); return res.end();
  }
  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    const body = parseBody(await readBody(req), req.headers['content-type']);
    if (body.grant_type === 'authorization_code') {
      const c = codes.get(body.code); if (!c) return json(400, { error: 'invalid_grant', error_description: 'unknown code' });
      codes.delete(body.code);
      const expect = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
      if (c.challenge && expect !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verifier mismatch' });
      console.log(`token (code) for ${user().email}`); return json(200, tokens(c));
    }
    if (body.grant_type === 'refresh_token') {
      const r = refreshTokens.get(body.refresh_token); if (!r) return json(403, { error: 'invalid_grant', error_description: 'unknown refresh token' });
      refreshTokens.delete(body.refresh_token); console.log(`token (refresh) for ${user().email}`); return json(200, tokens({ ...r, nonce: null }));
    }
    return json(400, { error: 'unsupported_grant_type' });
  }
  if (url.pathname === '/v2/logout') { res.writeHead(302, { location: q.get('returnTo') ?? '/' }); return res.end(); }
  if (url.pathname === '/dbconnections/change_password' && req.method === 'POST') { res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }); return res.end("We've just sent you an email to reset your password."); }
  json(404, { error: 'not_found', path: url.pathname });
}).listen(port, () => console.log(`fake issuer at ${issuer}`));
