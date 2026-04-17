FROM node:22-alpine AS base
RUN npm install -g pnpm

# ── Install dependencies ────────────────────────────────────────────────────
# Build context is the repo root so we can access the workspace lockfile.
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile --filter web... \
 && mkdir -p /app/node_modules /app/web/node_modules

# ── Build ───────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

# NEXT_PUBLIC_* vars are baked into the bundle at build time.
# Override via docker compose build args if your stack differs.
ARG NEXT_PUBLIC_SPACETIMEDB_URI=ws://localhost:3000
ARG NEXT_PUBLIC_SPACETIMEDB_DB_NAME=pear-dev
ARG NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID=""
ARG NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY=""
ARG SPACETIMEDB_PROXY_ORIGIN=""
# Optional host-delegation hooks. When set (in pear-cloud or any host that
# wraps pear), the web app routes auth/AI-user mutations through these URLs
# instead of expecting a self-hosted setup.
ARG NEXT_PUBLIC_PEAR_HOST_LOGOUT_URL=""
ARG NEXT_PUBLIC_PEAR_AI_USER_API_BASE=""

ENV NEXT_PUBLIC_SPACETIMEDB_URI=$NEXT_PUBLIC_SPACETIMEDB_URI
ENV NEXT_PUBLIC_SPACETIMEDB_DB_NAME=$NEXT_PUBLIC_SPACETIMEDB_DB_NAME
ENV NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID=$NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID
ENV NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY=$NEXT_PUBLIC_SPACETIMEAUTH_AUTHORITY
ENV SPACETIMEDB_PROXY_ORIGIN=$SPACETIMEDB_PROXY_ORIGIN
ENV NEXT_PUBLIC_PEAR_HOST_LOGOUT_URL=$NEXT_PUBLIC_PEAR_HOST_LOGOUT_URL
ENV NEXT_PUBLIC_PEAR_AI_USER_API_BASE=$NEXT_PUBLIC_PEAR_AI_USER_API_BASE

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules
COPY . .
# module_bindings is gitignored but must exist — run `spacetime generate` before building.
RUN pnpm --filter web build

# ── Production runtime ───────────────────────────────────────────────────────
FROM node:22-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3001

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# In a pnpm workspace the standalone output mirrors the directory structure:
#   standalone/
#     web/server.js   ← entry point
#     web/node_modules/
#     node_modules/
# We copy the whole standalone tree to /app, then run from /app/web.
WORKDIR /app
COPY --from=builder --chown=nextjs:nodejs /app/web/.next/standalone ./

# Static assets and public dir must live next to server.js (i.e. under /app/web/)
COPY --from=builder --chown=nextjs:nodejs /app/web/.next/static ./web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/web/public       ./web/public

USER nextjs

# Run server.js from its own directory so relative paths resolve correctly.
WORKDIR /app/web
EXPOSE 3001
CMD ["node", "server.js"]
