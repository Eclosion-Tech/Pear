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
if [ -f "$MODULE_WASM" ]; then
  echo "[pear] Publishing module from $MODULE_WASM as '$DB_NAME'..."
  spacetime publish \
    --bin-path "$MODULE_WASM" \
    "$DB_NAME" \
    --server http://localhost:3000 \
    --yes
  echo "[pear] Module published."
else
  echo "[pear] WARNING: $MODULE_WASM not found."
  echo "[pear] Run 'cd server && spacetime build' on the host first, then restart this container."
fi

# Hand off to the SpacetimeDB server process
wait $STDB_PID
