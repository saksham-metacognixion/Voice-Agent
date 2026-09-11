# Backend image for the EC2 compose stack. One image, two services:
#   api:    CMD ["node", "backend/api/dist/main.js"]
#   worker: CMD ["node", "backend/api/dist/worker.js"]
# Build context is the repo root:  docker build -f infra/Dockerfile .

FROM node:22-alpine AS base
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
RUN pnpm --filter @portal/api deploy --prod /deploy

# ---- runtime ----
FROM node:22-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /deploy .
USER app
EXPOSE 4000
CMD ["node", "dist/main.js"]
