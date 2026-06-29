import { test } from "node:test";
import assert from "node:assert/strict";

import { executeTool, type ConnLike } from "./tools.ts";
import {
  registerBridgeSql,
  unregisterBridgeSql,
  wsUriToHttpBase,
  type BridgeSqlClient,
} from "./bridge-sql.ts";

// Minimal fake connection: only the tables/reducers the bridge tool paths touch.
// `tool_bash` and `list_bridge_devices` read `bridge_device_summary` (device
// discovery) and `bridge_device_grant` (per-AI-user authorization, RLS-scoped
// to the calling AI user so iterating it yields exactly that user's grants).
function makeConn(opts: {
  devices: Array<{ id: bigint; name: string; platform: string; connected: boolean }>;
  grantedDeviceIds: bigint[];
}): { conn: ConnLike; enqueued: Array<Record<string, unknown>> } {
  const enqueued: Array<Record<string, unknown>> = [];
  const conn: ConnLike = {
    db: {
      bridge_device_summary: {
        iter: () => opts.devices.map((d) => ({ ...d, revokedAt: null })),
      },
      bridge_device_grant: {
        iter: () => opts.grantedDeviceIds.map((deviceId) => ({ deviceId })),
      },
    },
    reducers: {
      enqueueBridgeCommand: async (args: Record<string, unknown>) => {
        enqueued.push(args);
      },
    },
  };
  return { conn, enqueued };
}

const DEVICES = [
  { id: 1n, name: "MacBook", platform: "darwin-arm64", connected: true },
  { id: 2n, name: "Server", platform: "linux-x86_64", connected: true },
];

// A richer fake for the status-aware tool_bash wait: backs bridge_command (with a
// mutable status) and bridge_command_result so we can drive the daemon-side state
// machine the worker now reads. `enqueueBridgeCommand` inserts a Pending command;
// the test then mutates status / inserts a result to simulate the daemon.
function makeBridgeConn(opts: { connected?: boolean } = {}) {
  const connected = opts.connected ?? true;
  const commands: Array<{
    id: bigint;
    deviceId: bigint;
    command: string;
    conversationId: bigint;
    status: { tag: string };
  }> = [];
  const results: Array<{
    commandId: bigint;
    exitCode?: number;
    stdout: string;
    stderr: string;
    rejectionReason?: string;
    durationMs: bigint;
  }> = [];
  let nextId = 1n;
  const conn: ConnLike = {
    db: {
      bridge_device_summary: {
        iter: () => [{ id: 1n, name: "MacBook", platform: "darwin-arm64", connected, revokedAt: null }],
      },
      bridge_device_grant: { iter: () => [{ deviceId: 1n }] },
      bridge_command: { iter: () => commands },
      bridge_command_result: { iter: () => results },
    },
    reducers: {
      enqueueBridgeCommand: async (args: { deviceId: bigint; command: string; conversationId: bigint }) => {
        commands.push({
          id: nextId++,
          deviceId: args.deviceId,
          command: args.command,
          conversationId: args.conversationId ?? 0n,
          status: { tag: "Pending" },
        });
      },
    },
  };
  const setStatus = (id: bigint, tag: string) => {
    const c = commands.find((r) => r.id === id);
    if (c) c.status = { tag };
  };
  const addResult = (r: (typeof results)[number]) => results.push(r);
  return { conn, commands, setStatus, addResult };
}

test("list_bridge_devices only returns devices granted to the AI user", async () => {
  const { conn } = makeConn({ devices: DEVICES, grantedDeviceIds: [2n] });
  const out = JSON.parse(await executeTool(conn, "list_bridge_devices", {}, 0n));
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.devices.map((d: { device_id: number }) => d.device_id),
    [2],
  );
});

test("tool_bash on an ungranted device is denied and never enqueues", async () => {
  const { conn, enqueued } = makeConn({ devices: DEVICES, grantedDeviceIds: [2n] });
  const out = JSON.parse(
    await executeTool(conn, "tool_bash", { device_id: 1, command: "ls" }, 0n),
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /not granted/i);
  assert.equal(enqueued.length, 0, "must not enqueue a command for an ungranted device");
});

test("tool_bash passes the grant gate for a granted device", async () => {
  // Granted but reported not-connected, so the call fast-fails AFTER the grant
  // check on the connection check — proving the grant gate let it through
  // without needing the full enqueue/await-result round-trip.
  const { conn, enqueued } = makeConn({
    devices: [{ id: 1n, name: "MacBook", platform: "darwin-arm64", connected: false }],
    grantedDeviceIds: [1n],
  });
  const out = JSON.parse(
    await executeTool(conn, "tool_bash", { device_id: 1, command: "ls" }, 0n),
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /not connected/i, "should fail on connection, not on the grant gate");
  assert.equal(enqueued.length, 0);
});

test("tool_bash returns the result once the daemon completes it", async () => {
  const { conn, commands, setStatus, addResult } = makeBridgeConn();
  // Simulate the daemon: shortly after enqueue, mark Running then write a result.
  setTimeout(() => {
    const id = commands[0]?.id ?? 1n;
    setStatus(id, "Running");
    addResult({ commandId: id, exitCode: 0, stdout: "hi", stderr: "", durationMs: 5n });
  }, 150);
  const out = JSON.parse(
    await executeTool(conn, "tool_bash", { device_id: 1, command: "echo hi", timeout_ms: 3000 }, 0n),
  );
  assert.equal(out.ok, true);
  assert.equal(out.status, "completed");
  assert.equal(out.exit_code, 0);
});

test("tool_bash bails fast when the command stays Pending (daemon not consuming)", async () => {
  const { conn } = makeBridgeConn();
  // Never mark Running / never add a result → stuck Pending.
  const t0 = Date.now();
  const out = JSON.parse(
    await executeTool(conn, "tool_bash", { device_id: 1, command: "echo hi", timeout_ms: 1500 }, 0n),
  );
  const elapsed = Date.now() - t0;
  assert.equal(out.ok, false);
  assert.equal(out.status, "pending");
  // Should bail at the scaled grace (~500ms), well before the 1500ms timeout.
  assert.ok(elapsed < 1400, `expected early bail, took ${elapsed}ms`);
});

test("tool_bash surfaces AwaitingConfirmation instead of an opaque timeout", async () => {
  const { conn, commands, setStatus } = makeBridgeConn();
  setTimeout(() => setStatus(commands[0]?.id ?? 1n, "AwaitingConfirmation"), 100);
  const out = JSON.parse(
    await executeTool(conn, "tool_bash", { device_id: 1, command: "git push", timeout_ms: 1200 }, 0n),
  );
  assert.equal(out.ok, false);
  assert.equal(out.status, "awaiting_confirmation");
});

test("tool_bash does not return a prior identical command's result", async () => {
  const { conn, commands, addResult } = makeBridgeConn();
  // A previously-completed command with the SAME text + its result. The new run
  // must not match this stale row (which would falsely report success).
  commands.push({ id: 100n, deviceId: 1n, command: "echo hi", conversationId: 0n, status: { tag: "Completed" } });
  addResult({ commandId: 100n, exitCode: 0, stdout: "OLD", stderr: "", durationMs: 1n });
  // New run; never completes (no result for the new row).
  const out = JSON.parse(
    await executeTool(conn, "tool_bash", { device_id: 1, command: "echo hi", timeout_ms: 1500 }, 0n),
  );
  assert.equal(out.ok, false, "must not surface the stale prior success");
  assert.notEqual(out.status, "completed");
});

test("wsUriToHttpBase converts scheme and strips the subscribe path", () => {
  assert.equal(wsUriToHttpBase("ws://localhost:3000"), "http://localhost:3000");
  assert.equal(wsUriToHttpBase("wss://eclosion.cloud.pear.pro"), "https://eclosion.cloud.pear.pro");
  assert.equal(
    wsUriToHttpBase("ws://10.0.0.4:3000/v1/database/eclosion/subscribe"),
    "http://10.0.0.4:3000",
  );
});

test("tool_bash reads its result via the registered HTTP /sql client (subscription cache empty)", async () => {
  const AI_HEX = "c2002c31aabbccdd";
  // Connection whose bridge_command / bridge_command_result caches are EMPTY —
  // mimicking the production incremental-delivery gap. The grant + device tables
  // still report a connected, granted device so the call reaches the wait loop.
  const conn: ConnLike = {
    db: {
      bridge_device_summary: {
        iter: () => [{ id: 1n, name: "MacBook", platform: "darwin-arm64", connected: true, revokedAt: null }],
      },
      bridge_device_grant: { iter: () => [{ deviceId: 1n }] },
      bridge_command: { iter: () => [] },
      bridge_command_result: { iter: () => [] },
    },
    reducers: { enqueueBridgeCommand: async () => {} },
  };

  // Fake /sql client: the first read is the pre-enqueue snapshot (empty), then
  // the new command row "appears" and is Completed; its result is available.
  let cmdReads = 0;
  const client: BridgeSqlClient = {
    commandsForDevice: async () => {
      cmdReads += 1;
      if (cmdReads === 1) return [];
      return [
        { id: "7", deviceId: "1", command: "echo hi", conversationId: "0", status: { tag: "Completed" } },
      ];
    },
    resultForCommand: async (commandId) => {
      if (String(commandId) !== "7") return undefined;
      return { commandId: "7", exitCode: 0, stdout: "hi", stderr: "", rejectionReason: null, durationMs: 5n };
    },
  };
  registerBridgeSql(AI_HEX, client);
  try {
    const out = JSON.parse(
      await executeTool(
        conn,
        "tool_bash",
        { device_id: 1, command: "echo hi", timeout_ms: 3000 },
        0n,
        { aiIdentityHex: AI_HEX },
      ),
    );
    assert.equal(out.ok, true);
    assert.equal(out.status, "completed");
    assert.equal(out.exit_code, 0);
    assert.equal(out.command_id, 7);
  } finally {
    unregisterBridgeSql(AI_HEX);
  }
});

test("tool_bash via /sql does not surface a prior identical command's result", async () => {
  const AI_HEX = "deadbeefdeadbeef";
  const conn: ConnLike = {
    db: {
      bridge_device_summary: {
        iter: () => [{ id: 1n, name: "MacBook", platform: "darwin-arm64", connected: true, revokedAt: null }],
      },
      bridge_device_grant: { iter: () => [{ deviceId: 1n }] },
      bridge_command: { iter: () => [] },
      bridge_command_result: { iter: () => [] },
    },
    reducers: { enqueueBridgeCommand: async () => {} },
  };
  // A prior completed same-text command (id 100) exists from the first /sql read,
  // so it is captured in preCmdIds; the new run never produces its own row, so
  // the loop must NOT fall back to the stale id-100 success.
  const client: BridgeSqlClient = {
    commandsForDevice: async () => [
      { id: "100", deviceId: "1", command: "echo hi", conversationId: "0", status: { tag: "Completed" } },
    ],
    resultForCommand: async (commandId) =>
      String(commandId) === "100"
        ? { commandId: "100", exitCode: 0, stdout: "OLD", stderr: "", rejectionReason: null, durationMs: 1n }
        : undefined,
  };
  registerBridgeSql(AI_HEX, client);
  try {
    const out = JSON.parse(
      await executeTool(
        conn,
        "tool_bash",
        { device_id: 1, command: "echo hi", timeout_ms: 1200 },
        0n,
        { aiIdentityHex: AI_HEX },
      ),
    );
    assert.equal(out.ok, false, "must not surface the stale prior success");
    assert.notEqual(out.status, "completed");
  } finally {
    unregisterBridgeSql(AI_HEX);
  }
});

test("tool_bash without a readable grant table defers to the reducer (no TS pre-deny)", async () => {
  // Older bindings without bridge_device_grant: the TS pre-check is skipped and
  // enforcement falls to the reducer. Here the device is connected, so the call
  // proceeds to enqueue rather than being denied in TS.
  const { conn, enqueued } = makeConn({ devices: DEVICES, grantedDeviceIds: [] });
  // Drop the grant table to simulate the older-build path.
  delete (conn.db as { bridge_device_grant?: unknown }).bridge_device_grant;
  // No bridge_command/result tables → tool_bash returns the "unconfirmed" branch
  // after enqueuing, which is enough to confirm it was NOT denied in TS.
  const out = JSON.parse(
    await executeTool(conn, "tool_bash", { device_id: 1, command: "ls" }, 0n),
  );
  assert.doesNotMatch(JSON.stringify(out), /not granted/i);
  assert.equal(enqueued.length, 1, "should reach enqueue when the grant table is unreadable");
});
