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

Keep one representative file per **behaviour** (not just per event type): rename the capture you want
after what it proves and let the rest go. Fixtures are test data: a change in a provider's payload
shape should show up here as a diff, not as a surprise in production.

That is enforced rather than remembered. `FixtureWriter` names every capture
`<event>-<ISO timestamp>.json`, and the root `.gitignore` ignores exactly that shape under this
directory, so a raw capture is never committed by accident and a file only becomes tracked once you
have renamed it to the behaviour it stands for. Curated files carry no timestamp, which is what keeps
them tracked. The D2 and D3 captures the tables below describe were pruned this way on 16 Sep 2026;
42 unrenamed dumps went, and nothing read them.

## `retell/` — captured on D2, 15 Sep 2026

Named by behaviour, one file each. Twilio SIDs and signed media URLs are redacted in `body` **and**
`raw`, so `x-retell-signature` no longer verifies against `raw`; tests re-sign with
`RetellGateway.signWebhookBody()`. What each proves is in
[ADR 0003](../../../../docs/decisions/0003-retell-findings.md).

| File | Behaviour |
| --- | --- |
| `call_inbound-allow.json` | inbound authorisation request; we answered `{}` |
| `call_inbound-allow-with-override.json` | we answered with `override_agent_id`, `dynamic_variables`, `metadata`, `agent_override.max_call_duration_ms` |
| `call_inbound-decline_reject.json` | the decline: `{call_inbound:{reject:true}}` → busy, no call object, no cost |
| `call_inbound-decline_{403,500}-attempt*.json` | non-2xx → Retell retries 3× (~0.8 s apart, same `call_id`) then answers with the bound agent |
| `call_inbound-decline_timeout-attempt*.json` | no answer in 10 s → retries at 10 s, caller times out (`dial_no_answer`) |
| `call_started-{inbound,outbound,web}.json` | `call_cost` empty; inbound carries our `metadata` + `dynamic_variables` |
| `call_ended-inbound-max_duration_reached.json` | the inbound-webhook duration override cut the call at 60 s |
| `call_ended-inbound-user_hangup.json`, `call_ended-outbound-max_duration_reached.json` | normal billable ends, full `call_cost` |
| `call_ended-outbound-not_connected-{dial_busy,dial_no_answer}.json`, `call_ended-inbound-zero-duration.json` | the §14.2 zero-charge cases |
| `call_ended-web-max_duration_reached.json` | browser call (no telephony product) |
| `call_analyzed-{inbound,web,not_connected}.json` | `call_analysis.custom_analysis_data` with string/enum/boolean/number; zero values when absent |
| `api/*.json` | responses of every gateway call the spike made (voices, LLM, agent, versions, publish, web call, numbers, KB, concurrency, get-call) |

Regenerate with `pnpm --filter @portal/api spike:retell …` (header comment in
`backend/api/scripts/retell-spike.ts` lists the commands); the API must be running behind the
tunnel in `API_PUBLIC_URL`.

## `stripe/` — captured on D3, 15 Sep 2026

Captured through `stripe listen --forward-to localhost:4000/webhooks/stripe` and `stripe trigger`, so
the `stripe-signature` header is real but was computed with that day's CLI signing secret; tests do
not verify these headers, they re-sign the raw body with `StripeGateway.signForTest()`. What the
billing e2e suite asserts (`test/billing.e2e.test.ts`) is built from the same shape.

| File | Behaviour |
| --- | --- |
| `checkout.session.completed-*.json` | `payment_status: paid`, our `client_reference_id` + `metadata` → purchase paid, lot + ledger row, plan tier |
| `checkout.session.expired-*.json` | pending purchase → `abandoned` |

## `pricing/`

`config-v1.json` — a `pricing_configs.config_json` document for the unit and e2e tests (the §5.2
catalogue plus a CAD-only pack and a hidden partner pack to exercise region and visibility filters).
It is test data; the seed in `backend/db/prisma/seed-data/pricing-v1.ts` is what an empty database gets.

## `retell/api/d6-*.json` and `.d6-verify.json` — D6, 21 Sep 2026

`pnpm --filter @portal/api verify:d6` (`scripts/d6-staging-verify.ts`) runs the whole D6 flow
against the real Retell dev workspace and Stripe test mode through the ngrok tunnel: knowledge
base, number purchase, activation on SSE, a real inbound call from the D2 spike number, an
off-session auto top-up on a saved test card. It writes every provider id and the activation
progression to `backend/api/.d6-verify.json` (gitignored, never a secret) and releases the number
unless `--keep`. The webhooks it receives are captured here like any other run.
