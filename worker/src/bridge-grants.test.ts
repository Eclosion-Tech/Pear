import { test } from "node:test";
import assert from "node:assert/strict";

import { executeTool, type ConnLike } from "./tools.ts";

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
