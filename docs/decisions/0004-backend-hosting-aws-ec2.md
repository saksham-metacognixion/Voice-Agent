# ADR 0004 — Backend hosting: AWS EC2

- Status: accepted
- Date: 2026-09-11
- Deciders: Saksham, Prateek
- Supersedes: the Hosting row of [ADR 0001](0001-tech-stack.md) (Railway for api, worker, Redis)
- Note: ADR 0003 is reserved for the Retell findings written on D2.

## Context

ADR 0001 chose Railway for the long-running backend processes because it was the fastest managed option
for one developer. The team decided on 2026-09-11 to run the backend on AWS EC2 instead. Frontend hosting
(Vercel) and the database (Neon) are unchanged by this decision.

The constraints that matter are the same as before: BullMQ needs a persistent Node process with a TCP
Redis connection; `GET /events` holds long-lived SSE connections; the inbound authorisation webhook must
answer in under 300 ms at p95 with Redis on the same network hop.

## Decision

**One EC2 instance per environment (staging, prod) running the backend as Docker Compose services**, fronted
by Caddy for automatic TLS. Same image as before, built from `infra/Dockerfile`.

| Concern            | Choice                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instance           | `t3.small` for staging, `t3.medium` for prod (2 vCPU, 4 GB). Amazon Linux 2023 or Ubuntu 24.04.                                                                                                                    |
| Processes          | `docker compose` with services `api` (`node dist/main.js`), `worker` (`node dist/worker.js`), `redis` (redis:7, `appendonly yes`, `maxmemory-policy noeviction`), `caddy` (TLS + reverse proxy for `api.<domain>`) |
| Compose file       | `infra/docker-compose.prod.yml`, lands on D7                                                                                                                                                                       |
| Image registry     | GitHub Container Registry (`ghcr.io`), pushed by CI on `main`. ECR is a drop-in swap if the org prefers.                                                                                                           |
| Deploy             | GitHub Actions job: build → push image → SSH (or SSM Run Command) to the instance → `docker compose pull && docker compose up -d`. Zero-downtime is not required for MVP.                                          |
| Secrets            | AWS SSM Parameter Store (SecureString) loaded into the container environment at deploy time. Satisfies "secrets manager" in spec §17.                                                                              |
| SIP credential key | KMS-backed from P1 instead of an env DEK, since KMS is already available. Simplifies the P2 item.                                                                                                                  |
| Networking         | Security group: 443 open, 22 restricted to your IP or SSM only, Redis not exposed (compose-internal network). Elastic IP so `api.<domain>` is stable.                                                              |
| Backups            | Redis AOF on an EBS volume; Redis holds only caches and queues that can be rebuilt. Postgres stays on Neon with 7-day PITR.                                                                                        |
| Observability      | OpenTelemetry to Grafana Cloud as before; CloudWatch agent for host metrics and disk alarms.                                                                                                                       |

## Alternatives considered

**Railway** (ADR 0001). Less operational work. Set aside by team decision.

**ECS Fargate.** Proper managed containers, but two task definitions, an ALB, ECR and IAM roles are a full
day of setup for one developer and the ALB alone costs more than the EC2 instance. Right move later, not for MVP.

**ElastiCache for Redis.** Correct for production scale, but the smallest node costs more than the whole EC2
instance and adds a VPC hop on the 300 ms path. Redis stays co-located on the instance for MVP; move to
ElastiCache when the concurrency monitor shows sustained load.

**RDS Postgres instead of Neon.** RDS has PITR and would keep everything in one account, but Neon is
cheaper at this stage and gives branching for preview environments. Revisit when the org consolidates on AWS.

## Consequences

- An AWS account, IAM user or role for CI, one Elastic IP and two instances are needed on D1.
- The developer owns OS patching and Docker upkeep. Enable unattended security updates on the instance.
- Deploy is a scripted SSH or SSM step in CI rather than a platform hook; the runbook must document rollback
  (`docker compose up -d` with the previous image tag).
- Redis and the API share a host. If the instance dies, inbound calls decline until it is back. The Redis-down
  policy from D2 covers the same failure.
- Costs: roughly $15/month staging, $30/month prod, plus a few dollars for EBS and the Elastic IP.
