# Architecture decision records

One file per decision, numbered, never rewritten in place. If a decision changes, add a new ADR and mark
the old one superseded.

[../architecture.md](../architecture.md) is the map that ties these together — diagrams plus the
reasoning per subsystem. Where it and an ADR disagree, the ADR wins.

| #                                                      | Title                                                                                       | Status                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------- |
| [0001](0001-tech-stack.md)                             | Tech stack                                                                                  | accepted                      |
| [0002](0002-auth-provider-auth0.md)                    | Auth provider: Auth0 (supersedes ADR 0001 auth row)                                         | accepted (SDK row → 0008)     |
| [0003](0003-retell-findings.md)                        | Retell findings from the P0 spike (§21), incl. the Redis-down policy                        | accepted                      |
| [0004](0004-backend-hosting-aws-ec2.md)                | Backend hosting: AWS EC2 (supersedes ADR 0001 hosting row)                                  | accepted                      |
| [0005](0005-frontend-hosting-aws-amplify.md)           | Frontend hosting: AWS Amplify Hosting / CloudFront (supersedes ADR 0001 Vercel)             | superseded by 0008            |
| [0006](0006-tenancy-rls-and-append-only.md)            | Tenancy in Postgres: two roles, RLS, append-only history                                    | accepted                      |
| [0007](0007-llm-provider-openai.md)                    | LLM for prompt generation: OpenAI (supersedes ADR 0001 LLM row)                             | superseded by 0009            |
| [0008](0008-frontend-hosting-s3-cloudfront.md)         | Frontend hosting: S3 + CloudFront + ACM, static export (supersedes 0005)                    | accepted                      |
| [0009](0009-llm-provider-anthropic.md)                 | LLM for prompt generation: back to Anthropic, `claude-sonnet-5` (supersedes 0007)           | accepted                      |
| [0010](0010-wallet-ledger-and-pricing-config.md)       | Wallet ledger semantics, pricing config shape, Stripe webhook retries                       | accepted (§5 amended by 0011) |
| [0011](0011-call-runtime-and-queues.md)                | Call runtime: credit reservations, the queue hand-off, the recording proxy                  | accepted                      |
| [0012](0012-prompting-pipeline-and-agent-lifecycle.md) | The prompting pipeline and the agent lifecycle (D5)                                         | accepted                      |
| [0013](0013-provisioning-activation-and-billing.md)    | Knowledge, numbers, activation and billing (D6)                                             | accepted                      |
| [0014](0014-recurring-operations-and-staging.md)       | Recurring operations, notifications, the API contract and the staging stack (D7)            | accepted                      |
| [0015](0015-domain-and-aws-account-bootstrap.md)       | The domain (oraly.ai) and the AWS backend stack as one CloudFormation template              | accepted                      |
| [0016](0016-postgres-on-rds.md)                        | Postgres on Amazon RDS, private, in the environment stack (supersedes the Neon row of 0001) | accepted                      |
| [0017](0017-portal-foundation.md)                      | The portal foundation: session, §6.4 gating, theme tokens, SSE + polling (D8)               | accepted                      |
| [0018](0018-customer-dashboard.md)                     | The customer dashboard D1–D3 (D10)                                                          | accepted                      |
| [0019](0019-dashboard-d4-d7-mobile.md)                 | The dashboard D4–D7, one SSE stream, the bottom tab bar (D11)                               | accepted                      |
| [0020](0020-restaurant-menu-and-agent-identity.md)     | The restaurant menu as a knowledge role, the agent identity block                           | accepted                      |
| [0021](0021-admin-console.md)                          | The admin console: staff API, audit, pricing publish with Stripe sync, view-as (D12)        | accepted                      |
| [0022](0022-admin-p1-close.md)                         | The P1 admin close: tickets, refunds, staff invites, provisioning queue, D13 QA (D13)       | accepted                      |
| [0023](0023-brief-documents.md)                        | Business documents in the brief: a menu or price list on W2, verbatim in the prompt        | accepted                      |
| [0024](0024-knowledge-after-payment.md)                | What the agent knows comes after payment: W4 after go-live, auto-republish of a new base   | accepted                      |
| [0025](0025-production-hardening.md)                   | D14 hardening: disposable email ×2, origin check + API budget, OTel traces + Sentry errors, RDS PITR drill | accepted                      |
| [0026](0026-arabic-and-rtl.md)                          | Arabic + RTL in the portal: next-intl without routing, per-browser choice, pre-paint `dir`, logical CSS, API copy translated by id | accepted                      |

Template:

```markdown
# ADR NNNN — Title

- Status: proposed | accepted | superseded by ADR NNNN
- Date: YYYY-MM-DD
- Deciders:

## Context

## Decision

## Alternatives considered

## Consequences
```
- [0017 — Portal foundation: session, gating, theme tokens, local issuer](0017-portal-foundation.md)
