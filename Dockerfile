FROM caddy:2.11.7 AS gateway
FROM oven/bun:1.4.4 AS bun

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=file:/app/db/custom.db
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY mini-services/scramjet/package.json mini-services/scramjet/bun.lock ./mini-services/scramjet/
COPY mini-services/face-auth/package.json mini-services/face-auth/bun.lock ./mini-services/face-auth/
RUN bun install --cwd mini-services/scramjet --frozen-lockfile && bun install --cwd mini-services/face-auth --frozen-lockfile
COPY . .
RUN DATABASE_URL=file:/app/prisma/empty.db bun x prisma db push --skip-generate && bun run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=file:/app/db/custom.db
ENV PORT=8080
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=gateway /usr/bin/caddy /usr/local/bin/caddy
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl gosu openssl tini && rm -rf /var/lib/apt/lists/*
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/mini-services ./mini-services
COPY --from=builder --chown=node:node /app/prisma/schema.prisma /app/prisma/empty.db ./prisma/
COPY --chown=node:node Caddyfile ./Caddyfile
COPY --chown=node:node scripts/run-container.sh scripts/healthcheck.mjs ./scripts/
COPY --chown=node:node scripts/reset-admin-passcode.ts ./scripts/
COPY --chown=node:node src/lib/access/crypto.ts ./src/lib/access/
RUN mkdir -p /app/db /data/caddy /config/caddy && chown -R node:node /app/db /data /config
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=15s --start-period=120s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["bash", "scripts/run-container.sh"]