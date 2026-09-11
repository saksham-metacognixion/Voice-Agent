# infra/auth0

Source of truth for Auth0 tenant configuration (ADR 0002). Two tenants: customer and staff.

| Path                                        | Purpose                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `actions/customer-post-registration.js`     | Calls `POST /webhooks/auth` with `X-Action-Secret` so `users` is upserted (D1/D5)                      |
| `actions/customer-post-login.js`            | Adds `https://portal/email_verified` claim to the access token (D1)                                    |
| `actions/staff-post-login.js`               | Denies logins outside `STAFF_ALLOWED_EMAIL_DOMAIN`; adds `https://portal/mfa` when MFA completed (D12) |
| `tenant.customer.yaml`, `tenant.staff.yaml` | Auth0 Deploy CLI config, landing on D1                                                                 |

Deploy with the Auth0 Deploy CLI (`a0deploy`) so tenant settings are versioned here rather than clicked in.
