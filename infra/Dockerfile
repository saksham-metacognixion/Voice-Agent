# Backend image for the EC2 compose stack. One image, two services:
#   api:    CMD ["node", "backend/api/dist/main.js"]
#   worker: CMD ["node", "backend/api/dist/worker.js"]
# Build context is the repo root:  docker build -f infra/Dockerfile .

FROM node:22-alpine AS base
# pnpm's global bin dir must be on PATH before `pnpm add -g` works (D7 fix: the first real build).
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

# ---- prune to the api package and its workspace deps ----
FROM base AS pruner
RUN pnpm add -g turbo@2
COPY . .
RUN turbo prune @portal/api --docker

# ---- install + build ----
FROM base AS builder
COPY --from=pruner /repo/out/json/ .
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm turbo run build --filter=@portal/api...
# `--legacy`: pnpm 10's default deploy needs inject-workspace-packages; the legacy mode copies
# the built workspace packages (@portal/db, @portal/schemas) into /deploy as before.
RUN pnpm --filter @portal/api deploy --prod --legacy /deploy
# `pnpm deploy` reinstalls from the lockfile, so /deploy has a bare @prisma/client with no
# generated `.prisma/client` (and no query engine): `import { PrismaClient }` then fails at
# boot with "does not provide an export named 'PrismaClient'". The builder generated it
# above (`turbo run build` runs `prisma generate` for @portal/db, on this same alpine/musl
# platform), so copy that output into the deployed client's node_modules.
RUN set -eux; \
  SRC="$(dirname "$(find /repo/node_modules/.pnpm -path '*/node_modules/.prisma/client/index.js' | head -1)")"; \
  DST="$(find /deploy/node_modules/.pnpm -maxdepth 1 -type d -name '@prisma+client@*' | head -1)/node_modules/.prisma"; \
  test -d "$SRC"; mkdir -p "$DST"; cp -R "$SRC" "$DST/"; \
  ls "$DST/client" | grep -E 'index.js|libquery_engine' >/dev/null

# ---- runtime ----
FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /deploy .
USER app
EXPOSE 4000
# Liveness for the api service; the worker service overrides the command and is healthchecked
# through its heartbeat file (infra/docker-compose.prod.yml).
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1
CMD ["node", "dist/main.js"]
