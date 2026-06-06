FROM node:22-alpine

WORKDIR /app

RUN corepack enable pnpm

# Copy workspace manifests + lockfile so the install layer is cached unless
# dependencies change.
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY package.json ./
COPY worker/package.json ./worker/package.json
# pulp is a workspace:* dependency of the worker; its manifest must be present
# so the frozen install can link it.
COPY packages/pulp/package.json ./packages/pulp/package.json

# Install the worker and the pulp workspace package, so pulp's own deps
# (yjs, prosemirror-*) land in packages/pulp/node_modules for its .ts runtime.
RUN pnpm install --filter @pear/worker --filter @eclosion-tech/pulp --frozen-lockfile

# Copy worker source (includes pre-generated module_bindings) and the pulp
# src, whose .ts exports are consumed at runtime via tsx.
COPY worker/ ./worker/
COPY packages/pulp/src ./packages/pulp/src

CMD ["pnpm", "--filter", "@pear/worker", "start"]
