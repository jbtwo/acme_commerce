# syntax=docker/dockerfile:1
#
# Acme Commerce — standalone application container.
#
# One image, one process, configured entirely through environment variables. There is no
# Docker Compose file anywhere in this project: the application connects to a PostgreSQL
# instance that already exists and that it does not manage.
#
# Build:
#   docker build -t acme-commerce:0.1.0 .
#
# Run (see docs/UNRAID_DEPLOYMENT.md for the two connection models):
#   docker run -d --name acme-commerce -p 3000:3000 \
#     -e DATABASE_URL='postgres://acme_app:PASSWORD@HOST:5432/acme_commerce' \
#     -e APP_ENV=production \
#     acme-commerce:0.1.0
#
# Migrations are NOT applied on startup. Run them as a deliberate step:
#   docker exec acme-commerce node dist/db/cli.js up
#
# Node 26 is pinned here, in package.json `engines`, and in CI. Three environments on three
# different majors is a class of bug this project exists to teach rather than suffer.

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# ---------------------------------------------------------------------------
# Separated so that a source-only change reuses the cached dependency layer. `npm ci` installs
# exactly what package-lock.json specifies; `npm install` would be free to resolve something
# newer, which is how a reproducible build stops being reproducible.
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 2 — build
# ---------------------------------------------------------------------------
FROM node:26-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 — production dependencies only
# ---------------------------------------------------------------------------
# A fresh install rather than pruning the dev tree, so nothing dev-only can survive by
# accident. TypeScript, ESLint, Vitest, and the Redocly CLI have no business in a runtime
# image: they are attack surface and about 200 MB of it.
FROM node:26-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 4 — runtime
# ---------------------------------------------------------------------------
FROM node:26-alpine AS runtime

LABEL org.opencontainers.image.title="Acme Commerce API" \
      org.opencontainers.image.description="Ecommerce API platform used as an API-engineering learning environment." \
      org.opencontainers.image.source="https://github.com/jbtwo/acme_commerce" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

ENV NODE_ENV=production \
    APP_ENV=production \
    # 0.0.0.0 inside a container, not 127.0.0.1. Binding to loopback is the single most common
    # reason a container starts cleanly and then refuses every connection from outside it:
    # published ports reach the container's network interface, and loopback is not it.
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_LEVEL=info \
    # Structured JSON in a container. Pretty-printing is for a human at a terminal; here
    # something else is reading the output.
    LOG_PRETTY=false \
    # Explicitly off. Two replicas starting the same migration in the same second is a
    # genuinely bad afternoon. See docs/UNRAID_DEPLOYMENT.md for the deliberate step.
    MIGRATE_ON_STARTUP=false

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# package.json is required at runtime: src/version.ts reads its `version` so /health can report
# which build is deployed.
COPY package.json ./

# Run as the unprivileged `node` user that the base image already provides (uid 1000). A
# process that does not need root should not have it, and nothing here writes to the filesystem.
USER node

EXPOSE 3000

# Liveness only. /health deliberately does not touch PostgreSQL, so a database outage does not
# make Docker restart a perfectly healthy application container — which would turn a database
# blip into a restart storm. Use /ready to decide whether to send traffic.
#
# Implemented with node's built-in fetch rather than curl or wget, which the alpine base does
# not include and which would have to be installed purely for this line.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

# `node dist/index.js` directly, not `npm start`. npm would sit between Docker and the
# application as PID 1 and would not forward SIGTERM, so every container stop would be a
# 10-second wait followed by SIGKILL through live requests. src/index.ts installs its own
# SIGTERM and SIGINT handlers, drains in-flight requests, and closes the database pool.
CMD ["node", "dist/index.js"]
