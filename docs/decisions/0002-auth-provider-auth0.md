# ADR 0002 — Auth provider: Auth0

- Status: accepted; the **Frontend SDK** row is superseded by [ADR 0008](0008-frontend-hosting-s3-cloudfront.md) (`@auth0/nextjs-auth0` → `@auth0/auth0-spa-js`)
- Date: 2026-09-11
- Deciders: Saksham, Prateek
- Supersedes: the Auth row of [ADR 0001](0001-tech-stack.md) (Clerk)

## Context

Spec §6.2 recommends Clerk and accepts Auth0 or Supabase Auth. The team decided on Auth0 on 2026-09-11,
before any auth code was written. The requirements are unchanged:

- Customers: email + password, magic link, Google, Microsoft, optional TOTP MFA, email verification gate.
- Staff: separate auth organisation, Google Workspace sign-in only, MFA mandatory, 8-hour sessions.
- Backend verifies JWTs via JWKS, reads `X-Workspace-Id`, loads membership from our own tables.
- A user-created event reaches `POST /webhooks/auth` so `users` can be upserted.

## Decision

**Two Auth0 tenants**, one per audience, so issuers, JWKS endpoints, session policies and sign-in methods are
fully separate. Everything else in the architecture is unchanged: the identity provider is a JWT issuer and
nothing more; `tenants` and `memberships` remain the source of truth for authorisation.

| Requirement                            | Auth0 mechanism                                                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Email + password                       | Database connection (Username-Password-Authentication)                                                                                                                                     |
| Magic link                             | Passwordless email connection, "link" mode; Universal Login in identifier-first mode so both coexist                                                                                       |
| Google, Microsoft                      | Social connections `google-oauth2`, `windowslive`                                                                                                                                          |
| Customer TOTP MFA                      | MFA policy "Adaptive" or user-opt-in; factor: One-time Password                                                                                                                            |
| Email verification gate                | Post-Login Action adds `https://portal/email_verified` claim to the access token; API returns `403 EMAIL_UNVERIFIED` when false                                                            |
| Staff Google Workspace only            | Staff tenant: `google-oauth2` connection only; Post-Login Action denies any login whose `email` domain is not `STAFF_ALLOWED_EMAIL_DOMAIN` (avoids the paid Enterprise connection for MVP) |
| Staff MFA mandatory                    | Staff tenant MFA policy "Always"; Post-Login Action sets `https://portal/mfa: true` from `event.authentication.methods`; API rejects staff tokens without it                               |
| 8-hour staff sessions                  | Staff tenant session and refresh-token lifetimes set to 8 h absolute                                                                                                                       |
| JWKS verification                      | `jose` `createRemoteJWKSet(https://<tenant>/.well-known/jwks.json)`, issuer `https://<tenant>/`, audience = the API identifier registered in that tenant                                   |
| User created → our DB                  | Post-User-Registration Action calls `POST /webhooks/auth` with a shared secret header (`AUTH0_*_ACTION_SECRET`). Fallback: Log Stream webhook on `ss` events                               |
| Frontend SDK                           | `@auth0/nextjs-auth0` v4 in both Next.js apps. Server-side encrypted session cookie; the API client obtains the access token from a route handler that calls `getAccessToken()`            |
| Sessions list and revoke (D6 Security) | Auth0 Management API `GET/DELETE /api/v2/users/{id}/sessions` via a machine-to-machine application per tenant                                                                              |

## Alternatives considered

**Clerk** (spec recommendation, ADR 0001). Faster UI scaffolding via prebuilt components and cleaner
per-application separation. Set aside by team decision; no technical blocker.

**Supabase Auth.** Would introduce a Supabase project for auth alone while Postgres lives on Neon. Rejected.

**One Auth0 tenant with two applications.** Rejected: MFA policy, session lifetime and connection
allow-list are tenant-level settings in Auth0, so staff rules would leak onto customers or vice versa.

**Auth0 Organizations for workspaces.** Rejected for the same reason Clerk Organizations were: our
`tenants`/`memberships` tables own authorisation and role limits.

## Consequences

- Two more third-party tenants to provision on D1 and to promote to production on D15 (custom domains
  `auth.<domain>` and `auth-admin.<domain>` need CNAME verification; start early).
- Custom claims must be namespaced (`https://portal/...`); Auth0 strips un-namespaced custom claims.
- Prebuilt auth UI is Auth0 Universal Login (hosted), not in-app components. A1–A8 become thin pages that
  redirect to Universal Login plus our own post-login screens (A4 workspace setup, A7 switcher, A8 invite).
  This is a slight scope reduction on D8, not an increase.
- Auth0 Actions are code that lives in the Auth0 tenant. Keep their source in `infra/auth0/actions/` and
  deploy with the Auth0 Deploy CLI so they are versioned with the repo.
- Pricing: Free tier covers 25k MAU and social/passwordless connections. Confirm on D1 whether the tenant
  MFA "Always" policy and custom domains require the Essentials tier for the staff tenant.
- Renamed environment variables: see `.env.example`. No code used the old names.
