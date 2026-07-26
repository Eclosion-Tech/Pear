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

# The MCP core lives in the web tree but is platform-agnostic source, not a web
# module: both the MCP hosts (worker/src/mcp/) and chat tool parity
# (worker/src/mcp-parity-tools.ts) execute these implementations, so the worker
# cannot boot without them. Its only externals — @eclosion-tech/pulp,
# @modelcontextprotocol/sdk, yjs — are already worker dependencies.
COPY web/src/lib/mcp ./web/src/lib/mcp
COPY web/src/lib/api-endpoint ./web/src/lib/api-endpoint

# Node resolves bare specifiers by walking node_modules up from the IMPORTING
# file, and nothing above web/src/lib has one — pnpm installed the worker's deps
# under worker/node_modules. Point the web tree at them.
RUN ln -s /app/worker/node_modules /app/web/node_modules

CMD ["pnpm", "--filter", "@pear/worker", "start"]
