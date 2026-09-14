# Webhook fixtures

Real provider payloads, captured by `modules/webhooks` (`FixtureWriter`) while the API runs
in dev or staging. One file per event: `<provider>/<event_type>-<timestamp>.json`, holding the
request path, headers (secrets redacted) and the **exact raw body**, so signature-verification
tests run against the bytes a provider actually sends.

| Provider | Events we need (D2 exit check) |
| --- | --- |
| `retell/` | `call_inbound`, `call_started`, `call_ended`, `call_analyzed` |
| `stripe/` | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`, `charge.dispute.created` |
| `auth/` | `post_user_registration` |

Keep one representative file per event type and delete the rest before committing. Fixtures are
test data: a change in a provider's payload shape should show up here as a diff, not as a
surprise in production.
