# infra/auth0

Source of truth for Auth0 tenant configuration (ADR 0002). Two tenants: customer and staff.

| Path                                    | Purpose                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant.customer.yaml`                  | Customer tenant: the portal SPA, the Portal API, connections, attack protection, both Actions and their trigger bindings                                                                    |
| `tenant.staff.yaml`                     | Staff tenant: the admin SPA, the Staff API, Google only, the MFA policy (admin §2.1), the staff Action                                                                                      |
| `actions/customer-post-registration.js` | Calls `POST /webhooks/auth` with `X-Action-Secret` so `users` is upserted (D1/D5)                                                                                                           |
| `actions/customer-post-login.js`        | Adds `https://portal/email_verified`, `/email`, `/name` claims to the access token; posts `user.login` to `POST /webhooks/auth` as the safety net for a missed registration webhook (D1/D5) |
| `actions/staff-post-login.js`           | Denies logins outside `STAFF_ALLOWED_EMAIL_DOMAIN`; adds `https://portal/mfa` when MFA completed (D12)                                                                                      |
| `export/`                               | Gitignored snapshots from `pnpm auth0:export`, for diffing against the files above                                                                                                          |

```sh
pnpm auth0:validate            # render both files and check them — no credentials needed
pnpm auth0:check               # do the M2M credentials work, are the scopes granted
pnpm auth0:export <tenant>     # pull the live tenant down to diff against
pnpm auth0:plan   <tenant>     # what a deploy would change; changes nothing
pnpm auth0:deploy <tenant>     # apply
```

The Deploy CLI is a dev dependency (`auth0-deploy-cli`); `pnpm install` is the whole
installation. `infra/scripts/auth0.mjs` wraps it because it authenticates with
`AUTH0_DOMAIN` / `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` / `AUTH0_AUDIENCE`, and all four
names already mean something else in our `.env`.

**Read `docs/runbooks/auth0.md` before the first deploy against a tenant that already
exists** — the CLI matches objects by name, so the wrong name creates a second application
instead of failing.
