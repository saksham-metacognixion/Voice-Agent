# Runbook — Auth0 tenants

Two tenants, customer and staff (ADR 0002). Their configuration is a file in this repo,
not a dashboard someone remembers clicking: `infra/auth0/tenant.customer.yaml` and
`infra/auth0/tenant.staff.yaml`, deployed with the Auth0 Deploy CLI through
`infra/scripts/auth0.mjs`.

```sh
pnpm auth0:validate            # renders both files and checks them — no credentials needed
pnpm auth0:check               # do the credentials work, and are the scopes granted
pnpm auth0:export customer     # pull the live tenant into infra/auth0/export/customer/
pnpm auth0:plan   customer     # what a deploy would change; changes nothing
pnpm auth0:deploy customer     # apply
pnpm --filter @portal/api verify:auth0   # prove it works against the running API
```

`a0deploy` is a dev dependency of the repo (`auth0-deploy-cli`), so `pnpm install` is the
whole installation. There is nothing to install globally and nothing to log into.

---

## 1. The machine-to-machine application (do this first)

Everything below needs one M2M application **per tenant**. This is the only step that
cannot be scripted: it is the credential the scripts authenticate with.

In the tenant's dashboard:

1. **Applications → Create Application** → _Machine to Machine Applications_ → name it
   `Deploy CLI`. When it asks which API to authorise, pick **Auth0 Management API**.
2. Grant these scopes — the same list `pnpm auth0:check` verifies, so a missed one is one
   line of output, not a failed deploy halfway through:

   | Why                                                          | Scopes                                                                                      |
   | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
   | tenant settings                                              | `read:tenant_settings` `update:tenant_settings`                                             |
   | applications                                                 | `read:clients` `create:clients` `update:clients` `read:client_keys`                         |
   | APIs                                                         | `read:resource_servers` `create:resource_servers` `update:resource_servers`                 |
   | connections                                                  | `read:connections` `create:connections` `update:connections`                                |
   | actions                                                      | `read:actions` `create:actions` `update:actions`                                            |
   | attack protection                                            | `read:attack_protection` `update:attack_protection`                                         |
   | users (session revoke, and the probe user in `verify:auth0`) | `read:users` `create:users` `update:users` `delete:users`                                   |
   | **staff tenant only** — MFA (admin §2.1)                     | `read:guardian_factors` `update:guardian_factors` `read:mfa_policies` `update:mfa_policies` |

   No `delete:` scopes for clients, connections or resource servers: the wrapper runs with
   `AUTH0_ALLOW_DELETE=false` and nothing in this repo removes an Auth0 object.

3. Copy the Client ID and Client Secret into `.env`:

   ```
   AUTH0_CUSTOMER_M2M_CLIENT_ID=…
   AUTH0_CUSTOMER_M2M_CLIENT_SECRET=…
   AUTH0_STAFF_M2M_CLIENT_ID=…
   AUTH0_STAFF_M2M_CLIENT_SECRET=…
   ```

4. `pnpm auth0:check` — it prints the tenant domain and either "all required ones present"
   or the exact scopes that are missing.

`pnpm doctor` fails if one of a pair is set without the other, because a half-configured
tenant authenticates and then dies mid-deploy.

---

## 2. The first deploy against a tenant that already exists

Both dev tenants were configured by hand on 14 Sep, before these files existed. **The
deploy CLI matches objects by name.** A name in the YAML that does not exist in the tenant
is not an error — it creates a second application with a new `client_id`, and
`AUTH0_CLIENT_ID` in `.env` quietly goes on pointing at the old one. So, once per tenant:

```sh
pnpm auth0:export customer
diff infra/auth0/tenant.customer.yaml infra/auth0/export/customer/tenant.yaml
```

Reconcile the **names** first (`Voice Agent`, `Portal API`, `Admin Console`, `Staff API`,
`Username-Password-Authentication` — the customer SPA is called *Voice Agent* in the tenant,
which is why the file says that and not something tidier): either rename the object in the dashboard, or change
the name in our YAML. Then look at the values and decide, field by field, whether the file
or the tenant is right — the file is the source of truth from that moment on.

```sh
pnpm auth0:plan customer      # prints the change set, applies nothing
pnpm auth0:deploy customer
```

The export lands in `infra/auth0/export/` which is gitignored: it is a snapshot for
diffing, with tenant ids and placeholder secrets in it, not a second source of truth.

---

## 3. What the files manage, and what they deliberately do not

Managed: tenant name and session lifetimes, the SPA, the API, the database connection, the
Google connection's _client list_, attack protection, the Actions and — the part that is
usually forgotten — the **trigger bindings** that make an Action run.

Not managed, on purpose:

- **Social connection `options`** (Google/Microsoft client keys). They are secrets that
  belong in the dashboard, and a deploy that sent an empty `options` block would wipe them.
- **The M2M application itself.** A configuration that can rewrite its own credentials can
  lock itself out.
- **Anything with `delete:`.** Removing an application or a connection is a decision
  someone makes deliberately, not a side effect of deleting a block of YAML.

`pnpm auth0:validate` runs without credentials and catches the three mistakes that survive
a successful deploy: an unresolved `##KEYWORD##`, an action whose source file moved, and an
action that is deployed but bound to no trigger.

---

## 4. Verifying it actually works

```sh
pnpm --filter @portal/api verify:auth0
```

Needs the API **and the worker** running, and refuses to run with `APP_ENV=prod`. It checks,
in the order these things happen to a new customer:

1. the two Actions in the tenant are byte-for-byte the ones in `infra/auth0/actions/`, have
   their secrets, and are bound to their triggers;
2. `POST /webhooks/auth` accepts the shared secret that is really in `.env`, and the worker
   writes the `users` row; a replay answers 204;
3. a real access token carries `https://portal/email` and `https://portal/email_verified`
   — on the **access** token, which is the one the API verifies;
4. with that token and no `users` row, the first authenticated request provisions one
   (`AuthGuard.provision`).

Steps 3 and 4 need a token a browser would have got. Until the portal has a login screen
(D6), there are two ways to get one:

- **Paste one.** `verify:auth0 --token "<access token>"` — nothing in the tenant changes.
- **Password grant.** Set `AUTH0_CUSTOMER_TEST_CLIENT_ID` / `_SECRET` to an application
  with the _Password_ grant enabled, and the script creates a throwaway user, signs in as
  it, and deletes it again. Post-Login Actions run for this grant, which is what makes it a
  fair stand-in for a real sign-in.

  It is off by default and belongs in **dev tenants only**: the password grant sends a
  password to the token endpoint, which is exactly what PKCE exists to avoid. Create a
  separate _Regular Web Application_ for it rather than enabling the grant on `Portal Web`,
  and set **Settings → API Authorization Settings → Default Directory** to
  `Username-Password-Authentication`, or Auth0 answers `unsupported_configuration` and
  says nothing else.

Without either, steps 1–2 still run and 3–4 report as skipped, never as passed.

---

## 5. What has already cost an afternoon

All of these fail silently.

- **`403 unauthorized_client: Callback URL mismatch`** on `/authorize` is the tenant
  refusing the `redirect_uri` the SPA sent. The portal is a static export, so its callback
  is the **app origin itself** — `http://localhost:3000` in dev, `https://app-staging.oraly.ai`
  on staging — not a `/callback` path. The same value must be in all four lists of the
  `Portal Web` application: _Allowed Callback URLs_, _Allowed Logout URLs_, _Allowed Web
  Origins_ and _Allowed Origins (CORS)_.

  Fix it from the file — `PORTAL_URL` and the optional `PORTAL_ALT_URL` are what get
  deployed, and `pnpm auth0:validate` prints the resulting list before anything is sent:

  ```sh
  pnpm auth0:validate      # "Portal Web accepts: http://localhost:3000 …"
  pnpm auth0:plan customer # what would change in the tenant; changes nothing
  pnpm auth0:deploy customer
  ```

  That needs the M2M credentials from §1. Without them it is four fields in the dashboard
  under **Applications → Portal Web → Settings**, and `.env` should then be brought in line
  so the next deploy does not undo it.

  **One tenant serves more than one origin.** Set `PORTAL_ALT_URL` whenever a second app is
  pointed at the same tenant — a developer on localhost while staging is deployed — or
  deploying for one silently removes the other and every login there starts failing this way.
- **One tenant per Auth0 account on the free plan.** The second tenant needs a second
  account; sign up with a shared alias (`auth0@<domain>`), never a personal address.
- **An API identifier cannot be edited after creation.** Getting `AUTH0_CUSTOMER_AUDIENCE`
  wrong means deleting the API and starting over.
- **Deploying an Action is not running it.** It must be bound to a trigger. `triggers:` in
  the YAML does that; `pnpm auth0:validate` fails if an action is not bound.
- **Claims go on the access token** (`api.accessToken.setCustomClaim`). On the ID token
  only, the API sees `undefined` and every gated route answers `EMAIL_UNVERIFIED`.
- **The MFA claim needs the tenant policy too.** `staff-post-login.js` only records whether
  MFA happened. Without the `all-applications` Guardian policy — in
  `tenant.staff.yaml` — the claim is always `false` and `AuthGuard` rejects every staff
  token.
- **Customer two-factor needs an enabled factor, and the Action is the policy.** The
  tenant MFA policy stays "Never" (`guardianPolicies: []` in `tenant.customer.yaml`);
  `customer-post-login.js` calls `api.multifactor.enable` when A5 asks (`acr_values`
  multi-factor) or the person is already enrolled, never on a refresh-token grant or a
  session that already passed MFA. With every factor off — the live state until 24 Sep
  2026 — A5 signed the person straight back in and the status stayed "Not enabled".
  One-time Password and recovery codes are on. The MFA scopes are needed on both tenants.
- **A full `auth0:deploy customer` from a developer `.env` rewrites the shared dev
  tenant.** Callbacks come from `PORTAL_URL`/`PORTAL_ALT_URL` and the Action secrets from
  `API_PUBLIC_URL`; from a laptop that is localhost and an ngrok tunnel, which drops
  staging's callback and points staging's sign-in webhooks at the laptop. Set
  `PORTAL_ALT_URL` to the staging origin and `API_PUBLIC_URL` to the staging API before a
  full deploy, or make the one change through the Management API.
- **`a0deploy` reads `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` and
  `AUTH0_AUDIENCE` from the environment**, and all four mean something else in our `.env`
  (the customer SPA, and the portal API). Never run the binary directly against this repo's
  environment; `pnpm auth0:*` builds a clean environment for it.
- **The Action secret is a shared secret, not a signature.** `ACTION_SECRET` on the Action
  and `AUTH0_CUSTOMER_ACTION_SECRET` in `.env` drift the moment one is rotated alone;
  `verify:auth0` step 2 is the check for that.
