import { test } from "node:test";
import assert from "node:assert/strict";

import { executeTool, type ConnLike } from "./tools.ts";

// Fake connection for the tool_infer path: bridge_device_summary (connected
// precheck), bridge_device_grant (authorization), bridge_device_capability
// (provider precheck), bridge_command/_result (the wait loop), and the
// enqueueBridgeInference reducer inserting a Pending row that carries the
// caller's nonce (the reducer stamps kind="inference" server-side).
function makeInferConn(opts: {
  connected?: boolean;
  capabilities?: Array<{
    deviceId: bigint;
    provider: string;
    available: boolean;
    modelsJson?: string | null;
  }>;
} = {}) {
  const connected = opts.connected ?? true;
  const commands: Array<{
    id: bigint;
    deviceId: bigint;
    command: string;
    conversationId: bigint;
    status: { tag: string };
    nonce: string | null;
  }> = [];
  const results: Array<{
    commandId: bigint;
    exitCode?: number;
    stdout: string;
    stderr: string;
    rejectionReason?: string;
    durationMs: bigint;
  }> = [];
  const enqueued: Array<Record<string, unknown>> = [];
  let nextId = 1n;
  const conn: ConnLike = {
    db: {
      bridge_device_summary: {
        iter: () => [
          { id: 1n, name: "MacBook", platform: "darwin-arm64", connected, revokedAt: null },
        ],
      },
      bridge_device_grant: { iter: () => [{ deviceId: 1n }] },
      bridge_device_capability: { iter: () => opts.capabilities ?? [] },
      bridge_command: { iter: () => commands },
      bridge_command_result: { iter: () => results },
    },
    reducers: {
      enqueueBridgeInference: async (args: {
        deviceId: bigint;
        provider: string;
        model: string;
        payloadJson: string;
        conversationId: bigint;
        nonce: string;
      }) => {
        enqueued.push(args as unknown as Record<string, unknown>);
        commands.push({
          id: nextId++,
          deviceId: args.deviceId,
          command: `infer:${args.provider}${args.model ? `:${args.model}` : ""}`,
          conversationId: args.conversationId ?? 0n,
          status: { tag: "Pending" },
          nonce: args.nonce || null,
        });
      },
    },
  };
  const complete = (stdout: string) => {
    const id = commands[0]?.id ?? 1n;
    const c = commands.find((r) => r.id === id);
    if (c) c.status = { tag: "Completed" };
    results.push({ commandId: id, exitCode: 0, stdout, stderr: "", durationMs: 42n });
  };
  return { conn, commands, enqueued, complete };
}

const CLAUDE_CAP = { deviceId: 1n, provider: "claude-code", available: true };
const OLLAMA_CAP = {
  deviceId: 1n,
  provider: "ollama",
  available: true,
  modelsJson: '["llama3:8b","qwen2"]',
};

test("tool_infer denies an ungranted device and never enqueues", async () => {
  const { conn, enqueued } = makeInferConn();
  (conn.db as { bridge_device_grant: unknown }).bridge_device_grant = { iter: () => [] };
  const out = JSON.parse(
    await executeTool(conn, "tool_infer", { device_id: 1, provider: "claude-code", prompt: "hi" }, 0n),
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /not granted/i);
  assert.equal(enqueued.length, 0);
});

test("tool_infer fast-fails on a disconnected device", async () => {
  const { conn, enqueued } = makeInferConn({ connected: false });
  const out = JSON.parse(
    await executeTool(conn, "tool_infer", { device_id: 1, provider: "claude-code", prompt: "hi" }, 0n),
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /not connected/i);
  assert.equal(enqueued.length, 0);
});

test("tool_infer rejects a provider the device does not serve, listing what it has", async () => {
  const { conn, enqueued } = makeInferConn({ capabilities: [OLLAMA_CAP] });
  const out = JSON.parse(
    await executeTool(conn, "tool_infer", { device_id: 1, provider: "claude-code", prompt: "hi" }, 0n),
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /does not serve provider "claude-code"/);
  assert.match(out.error, /ollama/);
  assert.equal(enqueued.length, 0);
});

test("tool_infer rejects an unavailable provider (installed but daemon down)", async () => {
  const { conn, enqueued } = makeInferConn({
    capabilities: [{ deviceId: 1n, provider: "ollama", available: false }],
  });
  const out = JSON.parse(
    await executeTool(conn, "tool_infer", { device_id: 1, provider: "ollama", model: "llama3:8b", prompt: "hi" }, 0n),
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /currently unavailable/i);
  assert.equal(enqueued.length, 0);
});

test("tool_infer requires a model for ollama and lists the device's models", async () => {
  const { conn, enqueued } = makeInferConn({ capabilities: [OLLAMA_CAP] });
  const out = JSON.parse(
    await executeTool(conn, "tool_infer", { device_id: 1, provider: "ollama", prompt: "hi" }, 0n),
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /requires an explicit model/i);
  assert.match(out.error, /llama3:8b, qwen2/);
  assert.equal(enqueued.length, 0);
});

test("tool_infer happy path: enqueues with nonce+payload, returns the fenced answer", async () => {
  const { conn, enqueued, complete } = makeInferConn({ capabilities: [CLAUDE_CAP] });
  setTimeout(() => {
    complete(
      JSON.stringify({
        ok: true,
        provider: "claude-code",
        model: "claude-sonnet-5",
        output: "the answer is 42",
        duration_ms: 1234,
      }),
    );
  }, 50);
  const out = JSON.parse(
    await executeTool(
      conn,
      "tool_infer",
      {
        device_id: 1,
        provider: "claude-code",
        model: "claude-sonnet-5",
        prompt: "meaning of life?",
        system: "be brief",
        timeout_ms: 5_000,
      },
      0n,
    ),
  );
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.status, "completed");
  assert.equal(out.provider, "claude-code");
  assert.equal(out.model, "claude-sonnet-5");
  assert.equal(out.duration_ms, 1234);
  assert.match(out.output, /the answer is 42/);
  assert.match(out.output, /untrusted external data/i);

  assert.equal(enqueued.length, 1);
  const args = enqueued[0] as { payloadJson: string; nonce: string; provider: string };
  assert.equal(args.provider, "claude-code");
  assert.ok(args.nonce.length > 0, "must enqueue with a correlation nonce");
  const payload = JSON.parse(args.payloadJson);
  assert.equal(payload.prompt, "meaning of life?");
  assert.equal(payload.system, "be brief");
  assert.equal(payload.model, "claude-sonnet-5");
  assert.ok(payload.timeout_seconds >= 30, "device budget must have a sane floor");
});

test("tool_infer surfaces a provider failure as ok:false, never as an answer", async () => {
  const { conn, complete } = makeInferConn({ capabilities: [CLAUDE_CAP] });
  setTimeout(() => {
    complete(
      JSON.stringify({
        ok: false,
        provider: "claude-code",
        output: "",
        duration_ms: 3,
        error: "claude exited with 1: not logged in",
      }),
    );
  }, 50);
  const out = JSON.parse(
    await executeTool(
      conn,
      "tool_infer",
      { device_id: 1, provider: "claude-code", prompt: "hi", timeout_ms: 5_000 },
      0n,
    ),
  );
  assert.equal(out.ok, false);
  assert.equal(out.status, "provider_error");
  assert.match(out.error, /not logged in/);
});

test("tool_infer reports an unreadable envelope honestly", async () => {
  const { conn, complete } = makeInferConn({ capabilities: [CLAUDE_CAP] });
  setTimeout(() => complete("plain text, not an envelope"), 50);
  const out = JSON.parse(
    await executeTool(
      conn,
      "tool_infer",
      { device_id: 1, provider: "claude-code", prompt: "hi", timeout_ms: 5_000 },
      0n,
    ),
  );
  assert.equal(out.ok, false);
  assert.equal(out.status, "no_result");
  assert.match(out.note, /Do NOT claim/);
});

test("tool_infer proceeds without capability data (older module) and bails on stuck Pending", async () => {
  const { conn, enqueued } = makeInferConn({ capabilities: [] });
  const started = Date.now();
  const out = JSON.parse(
    await executeTool(
      conn,
      "tool_infer",
      { device_id: 1, provider: "claude-code", prompt: "hi", timeout_ms: 6_000 },
      0n,
    ),
  );
  assert.equal(out.ok, false);
  assert.equal(out.status, "pending");
  assert.equal(enqueued.length, 1, "no capability data must not block the attempt");
  assert.ok(Date.now() - started < 5_000, "stuck-Pending must bail before the full timeout");
});

test("list_bridge_devices includes each device's inference providers", async () => {
  const { conn } = makeInferConn({ capabilities: [CLAUDE_CAP, OLLAMA_CAP] });
  const out = JSON.parse(await executeTool(conn, "list_bridge_devices", {}, 0n));
  assert.equal(out.ok, true);
  assert.equal(out.devices.length, 1);
  const providers = out.devices[0].inference_providers;
  assert.deepEqual(
    providers.map((p: { provider: string }) => p.provider).sort(),
    ["claude-code", "ollama"],
  );
  const ollama = providers.find((p: { provider: string }) => p.provider === "ollama");
  assert.deepEqual(ollama.models, ["llama3:8b", "qwen2"]);
});
