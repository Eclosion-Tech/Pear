#!/usr/bin/env bash
# Disposable localhost-only SpacetimeDB conformance gate. No deployment keys,
# mailbox credentials, real message data, or model endpoints are used.
set -euo pipefail
cd "$(dirname "$0")/../.."

protected_mail_tmp=""
protected_mail_container=""
protected_mail_phase=prepare
cleanup_protected_mail() {
  protected_mail_status=$?
  trap - EXIT
  if [[ "$protected_mail_status" != 0 ]]; then
    printf 'FAIL protected_mail_ci phase=%s exit_code=%s\n' "$protected_mail_phase" "$protected_mail_status" >&2
    if [[ -n "$protected_mail_container" ]]; then
      protected_mail_state=$(docker inspect "$protected_mail_container" --format '{{.State.Status}}' 2>/dev/null || true)
      case "$protected_mail_state" in
        created|restarting|running|removing|paused|exited|dead) ;;
        *) protected_mail_state=unknown ;;
      esac
      protected_mail_container_exit=$(docker inspect "$protected_mail_container" --format '{{.State.ExitCode}}' 2>/dev/null || true)
      if [[ ! "$protected_mail_container_exit" =~ ^[0-9]+$ ]]; then
        protected_mail_container_exit=unknown
      fi
      # Never print container logs: once conformance starts they may contain
      # fixture identifiers or bearer-bearing transport diagnostics.
      printf 'FAIL protected_mail_ci_container state=%s exit_code=%s\n' "$protected_mail_state" "$protected_mail_container_exit" >&2
      # Resource metadata only; never emit server logs or private fixture rows.
      docker stats --no-stream --format 'FAIL protected_mail_ci_memory usage={{.MemUsage}}' "$protected_mail_container" 2>/dev/null >&2 || true
      docker exec "$protected_mail_container" df -Pk /tmp/protected-mail 2>/dev/null >&2 || true
    fi
  fi
  if [[ -n "$protected_mail_container" ]]; then
    if ! docker rm --force --volumes "$protected_mail_container" >/dev/null 2>&1; then
      printf 'FAIL protected_mail_ci_container_cleanup\n' >&2
      if [[ "$protected_mail_status" == 0 ]]; then protected_mail_status=1; fi
    fi
  fi
  if [[ -n "$protected_mail_tmp" ]]; then
    if ! rm -rf -- "$protected_mail_tmp"; then
      printf 'FAIL protected_mail_ci_temp_cleanup\n' >&2
      if [[ "$protected_mail_status" == 0 ]]; then protected_mail_status=1; fi
    fi
  fi
  exit "$protected_mail_status"
}
trap cleanup_protected_mail EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
protected_mail_set_phase() {
  protected_mail_phase=$1
  printf 'RUN protected_mail_ci phase=%s\n' "$protected_mail_phase"
}
protected_mail_wait_database() {
  local protected_mail_attempt
  for protected_mail_attempt in $(seq 1 60); do
    if curl --proto '=http' --max-time 2 -fsS "$protected_mail_base/v1/ping" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$(docker inspect "$protected_mail_container" --format '{{.State.Running}}' 2>/dev/null)" != true ]]; then
      break
    fi
    sleep 1
  done
  return 1
}
protected_mail_launch_database() {
  # Each owned group uses the same loopback port; only the restart group has
  # checkpoints, and its container/keys/storage survive the controlled restart.
  protected_mail_container=$(docker run --detach --network bridge \
    --publish "127.0.0.1:$protected_mail_requested_port:3000" \
    clockworklabs/spacetime:v2.0.3 start \
      --listen-addr 0.0.0.0:3000 --data-dir /tmp/protected-mail \
      --page_pool_max_size 268435456 --non-interactive)
  protected_mail_port=$(docker port "$protected_mail_container" 3000/tcp 2>/dev/null)
  [[ "$protected_mail_port" == "127.0.0.1:$protected_mail_requested_port" ]]
}
protected_mail_assert_database_alive() {
  # docker restart can revive an exited container. Require a healthy process
  # before the intentional restart and reject native panics across its logs.
  if [[ "$(docker inspect "$protected_mail_container" --format '{{.State.Running}}' 2>/dev/null)" != true ]] \
    || ! curl --proto '=http' --max-time 2 -fsS "$protected_mail_base/v1/ping" >/dev/null 2>&1; then
    printf 'FAIL protected_mail_ci_unexpected_database_exit\n' >&2
    return 1
  fi
  if ! docker logs "$protected_mail_container" >"$protected_mail_tmp/database-lifecycle.log" 2>&1; then
    printf 'FAIL protected_mail_ci_database_log_check\n' >&2
    return 1
  fi
  node --input-type=module - "$protected_mail_tmp/database-lifecycle.log" <<'JS'
import { readFileSync } from 'node:fs';
try {
  const log = readFileSync(process.argv[2], 'utf8');
  if (/durability actor vanished|panicked at|fatal runtime error/.test(log)) {
    process.stderr.write('FAIL protected_mail_ci_database_panic\n');
    process.exitCode = 1;
  }
  if (/(?:INFERENCE|RESULT|CONNECTOR|READ|EXECUTOR|INGESTION|DISCOVERY|SPARSE_CHECKPOINT|SPARSE_READ|SPARSE_EXECUTOR|COMPOSITION)_PRIVATE_SYNTHETIC_/.test(log)) {
    process.stderr.write('FAIL protected_mail_ci_database_private_body_log\n');
    process.exitCode = 1;
  }
} catch {
  process.stderr.write('FAIL protected_mail_ci_database_log_check\n');
  process.exitCode = 1;
}
JS
}
protected_mail_set_phase prepare
protected_mail_tmp=$(mktemp -d)
# This wrapper owns the whole server and destroys its storage in the trap.
# Pinned 2.0.3 can race database DELETE with late disconnect transactions on
# disk-backed servers. Retain only these synthetic DBs until server removal.
export PEAR_PROTECTED_MAIL_RETAIN_UNTIL_SERVER_CLEANUP=1
# Restart phases/checkpoints belong exclusively to this wrapper's owned server
# and temp directory. An inherited phase must not replace an ordinary fixture
# run or cause a caller's checkpoint to be read, overwritten or removed.
unset PEAR_COMPOSITION_BASELINE_WASM PEAR_AUTHORITY_RESTART_PHASE PEAR_AUTHORITY_RESTART_STATE_FILE \
  PEAR_ADMISSION_RESTART_PHASE PEAR_ADMISSION_RESTART_STATE_FILE \
  PEAR_INFERENCE_RESTART_PHASE PEAR_INFERENCE_RESTART_STATE_FILE \
  PEAR_RESULT_RESTART_PHASE PEAR_RESULT_RESTART_STATE_FILE \
  PEAR_CONNECTOR_RESTART_PHASE PEAR_CONNECTOR_RESTART_STATE_FILE \
  PEAR_READ_RESTART_PHASE PEAR_READ_RESTART_STATE_FILE \
  PEAR_INGESTION_RESTART_PHASE PEAR_INGESTION_RESTART_STATE_FILE \
  PEAR_DISCOVERY_RESTART_PHASE PEAR_DISCOVERY_RESTART_STATE_FILE \
  PEAR_SPARSE_CHECKPOINT_RESTART_PHASE PEAR_SPARSE_CHECKPOINT_RESTART_STATE_FILE \
  PEAR_SPARSE_READ_RESTART_PHASE PEAR_SPARSE_READ_RESTART_STATE_FILE

# The access fixture imports web MCP tools, including the shared page-panel
# package. Direct fixture execution does not run the web/worker test prebuild.
protected_mail_set_phase build_fixture_dependencies
pnpm --filter @pear/trellis-ui build

# Pinned last schema before private storage. Keep additive-upgrade coverage even
# after this gate runs on main, rather than comparing a schema to itself.
protected_mail_baseline_rev=7813c666fb9acfd1607d4457f033dfac3b91bb03
protected_mail_storage_baseline_rev=408076b0590ba5033e5f485f94a9424e5426c240
protected_mail_instruction_baseline_rev=44abbcd730c33e7c4200956d46ced3d714564254
protected_mail_authority_baseline_rev=0e12936bf6a63f7627efa99e426b2067668bfc2a
protected_mail_instruction_input_baseline_rev=941dee483bc2a753b9b27678ff4aca9d9824c9df
protected_mail_admission_baseline_rev=3d22c05f8920dcbe8605f172f13af4e0fe5925c8
protected_mail_inference_baseline_rev=f96337f9fdf88e1009ece81adfd4ea8a5b73ca61
protected_mail_result_baseline_rev=53acbfdde0869108346cdb1e1eb6696b40e85206
protected_mail_connector_baseline_rev=4f32a8184ded0a5d4c0cbfe23d1b2c51d3ce3053
protected_mail_read_baseline_rev=a37945ff9343c9fc4a99347bb9fc05ebb9620937
protected_mail_ingestion_baseline_rev=caacdb53d55d84ea745bdee5101309095c6d7b6b
protected_mail_discovery_baseline_rev=0f598f25a8fc66c81dcc2fa1490701d26cb3537f
protected_mail_sparse_checkpoint_baseline_rev=da7bc7f13e47aae9e3d548803844ecf79a8e98d5
protected_mail_sparse_read_baseline_rev=25918b61058b5b4780fa3e28e0c922ddc550321a
if [[ -z "${PEAR_UPGRADE_FROM_WASM:-}" ]]; then
  protected_mail_set_phase build_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_baseline_rev" "$protected_mail_tmp/baseline.wasm"
  export PEAR_UPGRADE_FROM_WASM="$protected_mail_tmp/baseline.wasm"
fi
if [[ -z "${PEAR_SOURCE_STATE_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_storage_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_storage_baseline_rev" "$protected_mail_tmp/storage-baseline.wasm"
  export PEAR_SOURCE_STATE_BASELINE_WASM="$protected_mail_tmp/storage-baseline.wasm"
fi
if [[ -z "${PEAR_INSTRUCTION_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_instruction_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_instruction_baseline_rev" "$protected_mail_tmp/instruction-baseline.wasm"
  export PEAR_INSTRUCTION_BASELINE_WASM="$protected_mail_tmp/instruction-baseline.wasm"
fi
if [[ -z "${PEAR_AUTHORITY_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_authority_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_authority_baseline_rev" "$protected_mail_tmp/authority-baseline.wasm"
  export PEAR_AUTHORITY_BASELINE_WASM="$protected_mail_tmp/authority-baseline.wasm"
fi
if [[ -z "${PEAR_INSTRUCTION_INPUT_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_instruction_input_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_instruction_input_baseline_rev" "$protected_mail_tmp/instruction-input-baseline.wasm"
  export PEAR_INSTRUCTION_INPUT_BASELINE_WASM="$protected_mail_tmp/instruction-input-baseline.wasm"
fi
if [[ -z "${PEAR_ADMISSION_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_admission_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_admission_baseline_rev" "$protected_mail_tmp/admission-baseline.wasm"
  export PEAR_ADMISSION_BASELINE_WASM="$protected_mail_tmp/admission-baseline.wasm"
fi
if [[ -z "${PEAR_INFERENCE_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_inference_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_inference_baseline_rev" "$protected_mail_tmp/inference-baseline.wasm"
  export PEAR_INFERENCE_BASELINE_WASM="$protected_mail_tmp/inference-baseline.wasm"
fi
if [[ -z "${PEAR_RESULT_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_result_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_result_baseline_rev" "$protected_mail_tmp/result-baseline.wasm"
  export PEAR_RESULT_BASELINE_WASM="$protected_mail_tmp/result-baseline.wasm"
fi
if [[ -z "${PEAR_CONNECTOR_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_connector_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_connector_baseline_rev" "$protected_mail_tmp/connector-baseline.wasm"
  export PEAR_CONNECTOR_BASELINE_WASM="$protected_mail_tmp/connector-baseline.wasm"
fi
if [[ -z "${PEAR_READ_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_read_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_read_baseline_rev" "$protected_mail_tmp/read-baseline.wasm"
  export PEAR_READ_BASELINE_WASM="$protected_mail_tmp/read-baseline.wasm"
fi
if [[ -z "${PEAR_INGESTION_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_ingestion_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_ingestion_baseline_rev" "$protected_mail_tmp/ingestion-baseline.wasm"
  export PEAR_INGESTION_BASELINE_WASM="$protected_mail_tmp/ingestion-baseline.wasm"
fi
if [[ -z "${PEAR_DISCOVERY_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_discovery_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_discovery_baseline_rev" "$protected_mail_tmp/discovery-baseline.wasm"
  export PEAR_DISCOVERY_BASELINE_WASM="$protected_mail_tmp/discovery-baseline.wasm"
fi
if [[ -z "${PEAR_SPARSE_CHECKPOINT_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_sparse_checkpoint_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_sparse_checkpoint_baseline_rev" "$protected_mail_tmp/sparse_checkpoint-baseline.wasm"
  export PEAR_SPARSE_CHECKPOINT_BASELINE_WASM="$protected_mail_tmp/sparse_checkpoint-baseline.wasm"
fi
if [[ -z "${PEAR_SPARSE_READ_BASELINE_WASM:-}" ]]; then
  protected_mail_set_phase build_sparse_read_baseline
  node scripts/ci/build-protected-mail-baseline.mjs "$protected_mail_sparse_read_baseline_rev" "$protected_mail_tmp/sparse_read-baseline.wasm"
  export PEAR_SPARSE_READ_BASELINE_WASM="$protected_mail_tmp/sparse_read-baseline.wasm"
fi
if [[ -z "${PEAR_PROTECTED_MAIL_WASM:-}" ]]; then
  protected_mail_set_phase build_current
  # Cargo can reuse a path package's older artifact across these source
  # trees when they share a target directory. Keep independent provenance.
  CARGO_TARGET_DIR="$protected_mail_tmp/current-target" cargo build --locked --release --target wasm32-unknown-unknown \
    --manifest-path server/spacetimedb/Cargo.toml
  cp "$protected_mail_tmp/current-target/wasm32-unknown-unknown/release/server.wasm" "$protected_mail_tmp/current.wasm"
  export PEAR_PROTECTED_MAIL_WASM="$protected_mail_tmp/current.wasm"
fi
protected_mail_set_phase verify_artifacts
if [[ ! -s "$PEAR_UPGRADE_FROM_WASM" || ! -s "$PEAR_SOURCE_STATE_BASELINE_WASM" \
  || ! -s "$PEAR_INSTRUCTION_BASELINE_WASM" || ! -s "$PEAR_AUTHORITY_BASELINE_WASM" \
  || ! -s "$PEAR_INSTRUCTION_INPUT_BASELINE_WASM" || ! -s "$PEAR_ADMISSION_BASELINE_WASM" \
  || ! -s "$PEAR_INFERENCE_BASELINE_WASM" || ! -s "$PEAR_RESULT_BASELINE_WASM" \
  || ! -s "$PEAR_CONNECTOR_BASELINE_WASM" || ! -s "$PEAR_READ_BASELINE_WASM" || ! -s "$PEAR_INGESTION_BASELINE_WASM" \
  || ! -s "$PEAR_DISCOVERY_BASELINE_WASM" || ! -s "$PEAR_SPARSE_CHECKPOINT_BASELINE_WASM" || ! -s "$PEAR_SPARSE_READ_BASELINE_WASM" || ! -s "$PEAR_PROTECTED_MAIL_WASM" ]]; then
  exit 1
fi
if cmp -s "$PEAR_UPGRADE_FROM_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_SOURCE_STATE_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_INSTRUCTION_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_AUTHORITY_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_INSTRUCTION_INPUT_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_ADMISSION_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_INFERENCE_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_RESULT_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_CONNECTOR_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_READ_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_INGESTION_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_DISCOVERY_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_SPARSE_CHECKPOINT_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM" \
  || cmp -s "$PEAR_SPARSE_READ_BASELINE_WASM" "$PEAR_PROTECTED_MAIL_WASM"; then
  printf 'FAIL protected_mail_ci_artifacts_identical\n' >&2
  exit 1
fi

protected_mail_set_phase start_database
# Use an explicit loopback port so a restart retains the checkpoint's exact
# origin. A competing bind fails startup before any fixture is loaded.
protected_mail_requested_port=$(node --input-type=module <<'JS'
import { createServer } from 'node:net';
const listener = createServer();
try {
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('invalid_address');
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  process.stdout.write(String(address.port));
} catch {
  try { listener.close(); } catch {}
  process.stderr.write('FAIL protected_mail_port_selection\n');
  process.exitCode = 1;
}
JS
)
if [[ ! "$protected_mail_requested_port" =~ ^[0-9]+$ ]]; then
  exit 1
fi
# The image's CLI entrypoint initializes disposable JWT keys. Invoking the
# standalone binary directly skips that setup and requires explicit key paths.
# Keep the container until our trap runs so failed startup retains exit state.
protected_mail_launch_database
protected_mail_base="http://127.0.0.1:$protected_mail_requested_port"
protected_mail_set_phase wait_database
protected_mail_wait_database
protected_mail_set_phase verify_view_dispatch
node scripts/ci/check-view-dispatch.mjs "$protected_mail_base" "$PEAR_PROTECTED_MAIL_WASM"
protected_mail_set_phase run_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_source_state_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-state-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_instruction_conformance
PEAR_INSTRUCTION_INPUT_BASELINE_WASM="" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-instructions-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_instruction_input_upgrade
PEAR_INSTRUCTION_BASELINE_WASM="" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-instructions-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_authority_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-authority-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_admission_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-admission-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_inference_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-inference-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_result_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-result-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_connector_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-connector-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_read_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-read-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_executor_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-executor-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_ingestion_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-ingestion-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_discovery_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-discovery-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_sparse_checkpoint_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-sparse-checkpoint-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_sparse_read_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-sparse-read-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_sparse_executor_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-sparse-executor-e2e.ts "$protected_mail_base"
protected_mail_set_phase run_composition_conformance
pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-composition-e2e.ts "$protected_mail_base"
protected_mail_set_phase finish_conformance_database
protected_mail_assert_database_alive
# These completed conformance databases have no restart checkpoints. Release
# their module hosts/storage as a whole rather than retaining them alongside
# every durability fixture. Do not DELETE individual live databases on 2.0.3.
docker rm --force --volumes "$protected_mail_container" >/dev/null
protected_mail_container=""
protected_mail_set_phase start_restart_group_database
protected_mail_launch_database
protected_mail_wait_database
protected_mail_set_phase seed_authority_restart
PEAR_AUTHORITY_BASELINE_WASM="" PEAR_AUTHORITY_RESTART_PHASE=seed \
  PEAR_AUTHORITY_RESTART_STATE_FILE="$protected_mail_tmp/restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-authority-e2e.ts "$protected_mail_base"
protected_mail_set_phase seed_admission_restart
PEAR_ADMISSION_BASELINE_WASM="" PEAR_ADMISSION_RESTART_PHASE=seed \
  PEAR_ADMISSION_RESTART_STATE_FILE="$protected_mail_tmp/admission-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-admission-e2e.ts "$protected_mail_base"
protected_mail_set_phase seed_inference_restart
PEAR_INFERENCE_BASELINE_WASM="" PEAR_INFERENCE_RESTART_PHASE=seed \
  PEAR_INFERENCE_RESTART_STATE_FILE="$protected_mail_tmp/inference-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-inference-e2e.ts "$protected_mail_base"
protected_mail_set_phase seed_result_restart
PEAR_RESULT_BASELINE_WASM="" PEAR_RESULT_RESTART_PHASE=seed \
  PEAR_RESULT_RESTART_STATE_FILE="$protected_mail_tmp/result-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-result-e2e.ts "$protected_mail_base"
protected_mail_set_phase seed_connector_restart
PEAR_CONNECTOR_BASELINE_WASM="" PEAR_CONNECTOR_RESTART_PHASE=seed \
  PEAR_CONNECTOR_RESTART_STATE_FILE="$protected_mail_tmp/connector-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-connector-e2e.ts "$protected_mail_base"
protected_mail_set_phase seed_read_restart
PEAR_READ_BASELINE_WASM="" PEAR_READ_RESTART_PHASE=seed \
  PEAR_READ_RESTART_STATE_FILE="$protected_mail_tmp/read-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-read-e2e.ts "$protected_mail_base"
protected_mail_set_phase seed_ingestion_restart
PEAR_INGESTION_BASELINE_WASM="" PEAR_INGESTION_RESTART_PHASE=seed \
  PEAR_INGESTION_RESTART_STATE_FILE="$protected_mail_tmp/ingestion-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-ingestion-e2e.ts "$protected_mail_base"
protected_mail_set_phase seed_discovery_restart
PEAR_DISCOVERY_BASELINE_WASM="" PEAR_DISCOVERY_RESTART_PHASE=seed \
  PEAR_DISCOVERY_RESTART_STATE_FILE="$protected_mail_tmp/discovery-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-discovery-e2e.ts "$protected_mail_base"
protected_mail_set_phase seed_sparse_checkpoint_restart
PEAR_SPARSE_CHECKPOINT_BASELINE_WASM="" PEAR_SPARSE_CHECKPOINT_RESTART_PHASE=seed \
  PEAR_SPARSE_CHECKPOINT_RESTART_STATE_FILE="$protected_mail_tmp/sparse-checkpoint-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-sparse-checkpoint-e2e.ts "$protected_mail_base"
protected_mail_set_phase seed_sparse_read_restart
PEAR_SPARSE_READ_BASELINE_WASM="" PEAR_SPARSE_READ_RESTART_PHASE=seed \
  PEAR_SPARSE_READ_RESTART_STATE_FILE="$protected_mail_tmp/sparse-read-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-sparse-read-e2e.ts "$protected_mail_base"
protected_mail_set_phase restart_database
protected_mail_assert_database_alive
docker restart -t 20 "$protected_mail_container" >/dev/null
protected_mail_restarted_port=$(docker port "$protected_mail_container" 3000/tcp 2>/dev/null)
if [[ "$protected_mail_restarted_port" != "127.0.0.1:$protected_mail_requested_port" ]]; then
  exit 1
fi
protected_mail_wait_database
protected_mail_set_phase verify_authority_restart
PEAR_AUTHORITY_RESTART_PHASE=resume PEAR_AUTHORITY_RESTART_STATE_FILE="$protected_mail_tmp/restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-authority-e2e.ts "$protected_mail_base"
protected_mail_set_phase verify_admission_restart
PEAR_ADMISSION_RESTART_PHASE=resume PEAR_ADMISSION_RESTART_STATE_FILE="$protected_mail_tmp/admission-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-admission-e2e.ts "$protected_mail_base"
protected_mail_set_phase verify_inference_restart
PEAR_INFERENCE_RESTART_PHASE=resume PEAR_INFERENCE_RESTART_STATE_FILE="$protected_mail_tmp/inference-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-inference-e2e.ts "$protected_mail_base"
protected_mail_set_phase verify_result_restart
PEAR_RESULT_RESTART_PHASE=resume PEAR_RESULT_RESTART_STATE_FILE="$protected_mail_tmp/result-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-result-e2e.ts "$protected_mail_base"
protected_mail_set_phase verify_connector_restart
PEAR_CONNECTOR_RESTART_PHASE=resume PEAR_CONNECTOR_RESTART_STATE_FILE="$protected_mail_tmp/connector-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-connector-e2e.ts "$protected_mail_base"
protected_mail_set_phase verify_read_restart
PEAR_READ_RESTART_PHASE=resume PEAR_READ_RESTART_STATE_FILE="$protected_mail_tmp/read-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-read-e2e.ts "$protected_mail_base"
protected_mail_set_phase verify_ingestion_restart
PEAR_INGESTION_RESTART_PHASE=resume PEAR_INGESTION_RESTART_STATE_FILE="$protected_mail_tmp/ingestion-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-ingestion-e2e.ts "$protected_mail_base"
protected_mail_set_phase verify_discovery_restart
PEAR_DISCOVERY_RESTART_PHASE=resume PEAR_DISCOVERY_RESTART_STATE_FILE="$protected_mail_tmp/discovery-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-discovery-e2e.ts "$protected_mail_base"
protected_mail_set_phase verify_sparse_checkpoint_restart
PEAR_SPARSE_CHECKPOINT_RESTART_PHASE=resume PEAR_SPARSE_CHECKPOINT_RESTART_STATE_FILE="$protected_mail_tmp/sparse-checkpoint-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-sparse-checkpoint-e2e.ts "$protected_mail_base"
protected_mail_set_phase verify_sparse_read_restart
PEAR_SPARSE_READ_RESTART_PHASE=resume PEAR_SPARSE_READ_RESTART_STATE_FILE="$protected_mail_tmp/sparse-read-restart-state.json" \
  pnpm --filter @pear/worker exec node --import tsx/esm scripts/protected-mail-sparse-read-e2e.ts "$protected_mail_base"
protected_mail_assert_database_alive
protected_mail_set_phase complete
