FROM node:22-alpine

WORKDIR /app

RUN corepack enable pnpm

# Copy workspace manifests + lockfile so the install layer is cached unless
# dependencies change.
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY package.json ./
COPY worker/package.json ./worker/package.json

# Install only the worker's dependencies.
RUN pnpm install --filter @pear/worker --frozen-lockfile

# Copy worker source (includes pre-generated module_bindings).
COPY worker/ ./worker/

CMD ["pnpm", "--filter", "@pear/worker", "start"]
