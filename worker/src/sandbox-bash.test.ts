import { test } from "node:test";
import assert from "node:assert/strict";

import { runSandboxBash, OUTPUT_CAP_CHARS } from "./sandbox-bash.js";

test("sandbox_bash: basic command with pipes", async () => {
  const r = await runSandboxBash('echo "hello world" | tr a-z A-Z');
  assert.equal(r.ok, true);
  assert.equal(r.stdout, "HELLO WORLD\n");
  assert.equal(r.exit_code, 0);
});

test("sandbox_bash: jq over seeded files", async () => {
  const r = await runSandboxBash("jq -r '.[].name' /data/rows.json | sort", {
    files: { "/data/rows.json": '[{"name":"beta"},{"name":"alpha"}]' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.stdout, "alpha\nbeta\n");
});

test("sandbox_bash: date reads the real server clock (#322)", async () => {
  const r = await runSandboxBash("date -u +%Y");
  assert.equal(r.ok, true);
  assert.equal(r.stdout!.trim(), String(new Date().getUTCFullYear()));
});

test("sandbox_bash: nonzero exit code is reported, not thrown", async () => {
  const r = await runSandboxBash("grep needle /nonexistent");
  assert.equal(r.ok, true);
  assert.notEqual(r.exit_code, 0);
});

test("sandbox_bash: state does not persist across calls", async () => {
  const w = await runSandboxBash('echo "leak" > /tmp/state.txt && cat /tmp/state.txt');
  assert.equal(w.ok, true);
  assert.equal(w.stdout, "leak\n");
  const r = await runSandboxBash("cat /tmp/state.txt");
  assert.equal(r.ok, true);
  assert.notEqual(r.exit_code, 0, "file from a prior call must not exist");
});

test("sandbox_bash: wall-clock timeout kills the isolate", async () => {
  const r = await runSandboxBash("sleep 30", { timeoutMs: 500 });
  assert.equal(r.ok, false);
  assert.equal(r.timed_out, true);
});

test("sandbox_bash: oversized stdout is truncated and flagged", async () => {
  const r = await runSandboxBash("seq 1 50000");
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.ok(r.stdout!.length <= OUTPUT_CAP_CHARS + 100);
  assert.match(r.stdout!, /output truncated/);
});

test("sandbox_bash: empty command is rejected without spawning", async () => {
  const r = await runSandboxBash("   ");
  assert.equal(r.ok, false);
  assert.match(r.error!, /empty/);
});

test("sandbox_bash: seed budget is enforced", async () => {
  const r = await runSandboxBash("wc -c /big", {
    files: { "/big": "x".repeat(2_000_001) },
  });
  assert.equal(r.ok, false);
  assert.match(r.error!, /seed files exceed/);
});

test("sandbox_bash: no network — curl is unavailable", async () => {
  const r = await runSandboxBash("curl https://example.com");
  assert.equal(r.ok, true);
  assert.notEqual(r.exit_code, 0, "curl must not succeed without network config");
});
