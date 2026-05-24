#!/bin/sh
set -e

DATA_DIR="${STDB_DATA_DIR:-/stdb/data}"
MODULE_WASM="${MODULE_WASM:-/module/server.wasm}"
DB_NAME="${STDB_DB_NAME:-pear-dev}"

mkdir -p "$DATA_DIR"
echo "[pear] Starting SpacetimeDB..."
spacetime start --data-dir="$DATA_DIR" --listen-addr=0.0.0.0:3000 --non-interactive &
STDB_PID=$!

# Wait for SpacetimeDB HTTP API to be ready.
# Use /v1/ping which returns HTTP 200 — the root path returns 404 and wget
# treats any 4xx/5xx as failure (exit code 8), causing the loop to never exit.
echo "[pear] Waiting for SpacetimeDB to accept connections..."
until wget -qO- http://localhost:3000/v1/ping > /dev/null 2>&1; do
  sleep 1
done
echo "[pear] SpacetimeDB ready."

# Publish the pre-built module WASM
# Some deploy paths accidentally create /module/server.wasm as a directory
# containing server.wasm. Normalize to the nested file in that case.
if [ -d "$MODULE_WASM" ] && [ -f "$MODULE_WASM/server.wasm" ]; then
  echo "[pear] Detected directory at $MODULE_WASM; using $MODULE_WASM/server.wasm"
  MODULE_WASM="$MODULE_WASM/server.wasm"
fi

if [ -f "$MODULE_WASM" ]; then
  echo "[pear] Publishing module from $MODULE_WASM as '$DB_NAME'..."
  # --break-clients matches lifecycle's production migration policy (see
  # lifecycle/src/provisioner.rs publish_module). Without it, additive
  # schema changes like "new column with default value" are rejected by
  # SpacetimeDB 2.0.3's default `Compatible` policy with HTTP 400
  # ClientBreakingChangeDisallowed. Self-hosted dev environments rolling
  # forward the module version need the same opt-in lifecycle gets via
  # the 2-step pre-publish flow. Client bindings are regenerated separately
  # before this image is built, so client-side compatibility is already
  # handled by the time we publish.
  if spacetime publish \
    --bin-path "$MODULE_WASM" \
    "$DB_NAME" \
    --server http://localhost:3000 \
    --break-clients \
    --yes; then
    echo "[pear] Module published."
  else
    echo "[pear] WARNING: Initial publish failed. Clearing stale spacetime CLI state and retrying..."
    rm -rf /root/.config/spacetime
    mkdir -p /root/.config/spacetime

    if spacetime publish \
      --bin-path "$MODULE_WASM" \
      "$DB_NAME" \
      --server http://localhost:3000 \
      --break-clients \
      --yes; then
      echo "[pear] Module published on retry."
    else
      echo "[pear] ERROR: Module publish failed after retry."
      echo "[pear] SpacetimeDB will keep running, but clients may fail until publish succeeds."
    fi
  fi
else
  echo "[pear] WARNING: $MODULE_WASM not found."
  echo "[pear] Run 'cd server && spacetime build' on the host first, then restart this container."
fi

# Hand off to the SpacetimeDB server process
wait $STDB_PID
