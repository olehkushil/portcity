# syntax=docker/dockerfile:1.7
# Multi-stage build: deps -> build (prisma generate, nest build) -> runner (node:24-alpine, non-root).
# The same image runs the API (default CMD) and the worker (CMD ["node", "dist/worker.js"]).

ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
COPY prisma ./prisma
# Installs dependencies and downloads Prisma engines; @prisma/client postinstall generates the client.
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate \
  && npm run build \
  && npm prune --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    WORKER_PORT=3001 \
    HOST=0.0.0.0 \
    LOG_PRETTY=false
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl \
  && addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --chown=app:app docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh
USER app
EXPOSE 3000 3001
# HEALTH_PORT lets the worker container probe WORKER_PORT with the same image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.HEALTH_PORT || process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["node", "dist/main.js"]
