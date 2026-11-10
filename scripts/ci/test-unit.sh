#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node --test scripts/ci/*.test.mjs
node scripts/ci/check-bindings.mjs
cargo test --locked --manifest-path server/spacetimedb/Cargo.toml
pnpm --filter @eclosion-tech/sentinel test
pnpm --filter @pear/web test
pnpm --filter @pear/worker test
# Pinned-library experiments use only synthetic data and loopback TLS.
pnpm --dir worker exec node --import tsx/esm scripts/protected-mail-imap-reuse-spike.ts
pnpm --dir worker exec node --import tsx/esm scripts/protected-mail-mime-reuse-spike.ts
