# Architecture decision records

One file per decision, numbered, never rewritten in place. If a decision changes, add a new ADR and mark
the old one superseded.

[../architecture.md](../architecture.md) is the map that ties these together — diagrams plus the
reasoning per subsystem. Where it and an ADR disagree, the ADR wins.

| #                                            | Title                                                                           | Status                    |
| -------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------- |
| [0001](0001-tech-stack.md)                   | Tech stack                                                                      | accepted                  |
| [0002](0002-auth-provider-auth0.md)          | Auth provider: Auth0 (supersedes ADR 0001 auth row)                             | accepted (SDK row → 0008) |
| [0003](0003-retell-findings.md)              | Retell findings from the P0 spike (§21), incl. the Redis-down policy            | accepted                  |
| [0004](0004-backend-hosting-aws-ec2.md)      | Backend hosting: AWS EC2 (supersedes ADR 0001 hosting row)                      | accepted                  |
| [0005](0005-frontend-hosting-aws-amplify.md) | Frontend hosting: AWS Amplify Hosting / CloudFront (supersedes ADR 0001 Vercel) | superseded by 0008        |
| [0006](0006-tenancy-rls-and-append-only.md)  | Tenancy in Postgres: two roles, RLS, append-only history                        | accepted                  |
| [0007](0007-llm-provider-openai.md)          | LLM for prompt generation: OpenAI (supersedes ADR 0001 LLM row)                 | superseded by 0009        |
| [0008](0008-frontend-hosting-s3-cloudfront.md) | Frontend hosting: S3 + CloudFront + ACM, static export (supersedes 0005)       | accepted                  |
| [0009](0009-llm-provider-anthropic.md)       | LLM for prompt generation: back to Anthropic, `claude-sonnet-5` (supersedes 0007)| accepted                  |
| [0010](0010-wallet-ledger-and-pricing-config.md) | Wallet ledger semantics, pricing config shape, Stripe webhook retries       | accepted (§5 amended by 0011) |
| [0011](0011-call-runtime-and-queues.md)      | Call runtime: credit reservations, the queue hand-off, the recording proxy      | accepted                  |

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
