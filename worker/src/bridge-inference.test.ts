import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BridgeHarnessProvider,
  BridgeInferenceProvider,
  harnessSessionId,
  latestUserMessage,
  parseBridgeBackendBinding,
  renderTranscript,
  toOllamaMessages,
} from "./bridge-inference.ts";
import { getProviderForAiUser, invalidateProviderCache } from "./providers.ts";
import type { Message } from "./providers.ts";

test("parseBridgeBackendBinding accepts bridge mode and rejects everything else", () => {
  assert.deepEqual(
    parseBridgeBackendBinding('{"mode":"bridge","device_id":1,"provider":"claude-code","model":"m"}'),
    {
      mode: "bridge",
      device_id: 1,
      provider: "claude-code",
      model: "m",
      cwd: undefined,
      permission_mode: undefined,
      allowed_tools: undefined,
    },
  );
  assert.equal(parseBridgeBackendBinding(undefined), undefined);
  assert.equal(parseBridgeBackendBinding(""), undefined);
  assert.equal(parseBridgeBackendBinding('{"mode":"cloud-api"}'), undefined);
  assert.equal(parseBridgeBackendBinding('{"mode":"bridge","provider":"x"}'), undefined, "device_id required");
  assert.equal(parseBridgeBackendBinding("{not json"), undefined);
});

test("renderTranscript flattens turns and marks non-text content", () => {
  const messages: Message[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      ],
    },
  ];
  const prompt = renderTranscript(messages);
  assert.match(prompt, /Human: hello/);
  assert.match(prompt, /Assistant: hi there/);
  assert.match(prompt, /not forwarded over the bridge/);
  assert.ok(prompt.trimEnd().endsWith("Assistant:"), "must end with the assistant cue");
});

// Minimal conn whose ai_user_config row carries a bridge binding.
function makeConn(opts: {
  binding?: string;
  apiKey?: string;
  connected?: boolean;
  driveResult?: (commands: FakeCmd[], results: FakeRes[]) => void;
}) {
  type Cmd = FakeCmd;
  const commands: Cmd[] = [];
  const results: FakeRes[] = [];
  let nextId = 1n;
  const conn = {
    db: {
      ai_user_config: {
        id: {
          find: (_id: bigint) => ({
            id: 5n,
            identity: { toHexString: () => "0xai5" },
            createdBy: { toHexString: () => "0xhuman" },
            provider: { tag: "Anthropic" },
            model: "claude-sonnet-5",
            endpoint: undefined,
            apiKey: opts.apiKey,
            systemPrompt: undefined,
            maxTokens: 4096,
            inferenceBackendJson: opts.binding,
          }),
        },
      },
      bridge_device_summary: {
        iter: () => [
          {
            id: 1n,
            name: "MacBook",
            platform: "darwin-arm64",
            connected: opts.connected ?? true,
            revokedAt: null,
          },
        ],
      },
      bridge_command: { iter: () => commands },
      bridge_command_result: { iter: () => results },
    },
    reducers: {
      enqueueBridgeInference: (args: { provider: string; nonce: string; payloadJson: string }) => {
        commands.push({
          id: nextId++,
          deviceId: 1n,
          command: `infer:${args.provider}`,
          conversationId: 0n,
          status: { tag: "Pending" },
          nonce: args.nonce,
          payloadJson: args.payloadJson,
        });
        opts.driveResult?.(commands, results);
      },
    },
  };
  return { conn, commands, results };
}
type FakeCmd = {
  id: bigint;
  deviceId: bigint;
  command: string;
  conversationId: bigint;
  status: { tag: string };
  nonce: string;
  payloadJson?: string;
};
type FakeRes = {
  commandId: bigint;
  exitCode?: number;
  stdout: string;
  stderr: string;
  rejectionReason?: string;
  durationMs: bigint;
};

const BINDING = '{"mode":"bridge","device_id":1,"provider":"claude-code","model":"local-default"}';
const OLLAMA_BINDING = { mode: "bridge", device_id: 1, provider: "ollama", model: "llama3.1:8b" } as const;

test("toOllamaMessages translates tool_use/tool_result and keeps the id→name map", () => {
  const messages: Message[] = [
    { role: "user", content: "open the pear page" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "on it" },
        { type: "tool_use", id: "bridge_abc", name: "get_page", input: { page_id: 68 } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "bridge_abc", content: "# Pear\n..." }],
    },
  ];
  const out = toOllamaMessages("sys", messages);
  assert.deepEqual(out[0], { role: "system", content: "sys" });
  assert.deepEqual(out[1], { role: "user", content: "open the pear page" });
  assert.deepEqual(out[2], {
    role: "assistant",
    content: "on it",
    tool_calls: [{ function: { name: "get_page", arguments: { page_id: 68 } } }],
  });
  assert.deepEqual(out[3], { role: "tool", content: "# Pear\n...", tool_name: "get_page" });
});

test("getProviderForAiUser resolves a bridge binding without an API key", () => {
  const { conn } = makeConn({ binding: BINDING });
  const resolved = getProviderForAiUser(conn as never, 5n);
  invalidateProviderCache(conn as never, 5n);
  assert.ok(resolved.provider instanceof BridgeInferenceProvider);
  assert.equal(resolved.model, "local-default", "binding model overrides config model");
  assert.equal(resolved.providerTag, "Anthropic");
});

test("getProviderForAiUser still throws for keyless cloud config without a binding", () => {
  const { conn } = makeConn({ binding: undefined, apiKey: undefined });
  assert.throws(() => getProviderForAiUser(conn as never, 5n), /no API key/);
});

test("bridge chat returns the device's answer as a text block", async () => {
  const { conn } = makeConn({
    binding: BINDING,
    driveResult: (commands, results) => {
      const cmd = commands[commands.length - 1];
      setTimeout(() => {
        cmd.status = { tag: "Completed" };
        results.push({
          commandId: cmd.id,
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, provider: "claude-code", output: "bridged answer", duration_ms: 7 }),
          stderr: "",
          durationMs: 7n,
        });
      }, 30);
    },
  });
  const provider = new BridgeInferenceProvider(
    conn as never,
    "0xai5",
    { mode: "bridge", device_id: 1, provider: "claude-code", model: "local-default" },
  );
  const response = await provider.chat({
    model: "claude-sonnet-5",
    maxTokens: 1024,
    system: [{ text: "be kind" }],
    messages: [{ role: "user", content: "hello" }],
  });
  assert.deepEqual(response.content, [{ type: "text", text: "bridged answer" }]);
  assert.equal(response.stopReason, "end_turn");
});

test("bridge chat sends the binding model + flattened system in the payload", async () => {
  let seenPayload: string | undefined;
  const { conn } = makeConn({
    binding: BINDING,
    driveResult: (commands, results) => {
      const cmd = commands[commands.length - 1];
      seenPayload = cmd.payloadJson;
      setTimeout(() => {
        cmd.status = { tag: "Completed" };
        results.push({
          commandId: cmd.id,
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, output: "x" }),
          stderr: "",
          durationMs: 1n,
        });
      }, 10);
    },
  });
  const provider = new BridgeInferenceProvider(conn as never, "0xai5", {
    mode: "bridge",
    device_id: 1,
    provider: "claude-code",
    model: "local-default",
  });
  await provider.chat({
    model: "catalog-model",
    maxTokens: 512,
    system: [{ text: "part one" }, { text: "part two" }],
    messages: [{ role: "user", content: "q" }],
  });
  const payload = JSON.parse(seenPayload ?? "{}");
  assert.equal(payload.model, "local-default");
  assert.equal(payload.system, "part one\n\npart two");
  assert.match(payload.prompt, /Human: q/);
});

test("ollama binding sends structured chat with tools and maps tool_calls back", async () => {
  let seenPayload: string | undefined;
  const { conn } = makeConn({
    binding: JSON.stringify(OLLAMA_BINDING),
    driveResult: (commands, results) => {
      const cmd = commands[commands.length - 1];
      seenPayload = cmd.payloadJson;
      setTimeout(() => {
        cmd.status = { tag: "Completed" };
        results.push({
          commandId: cmd.id,
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            provider: "ollama",
            output: "",
            tool_calls: [{ name: "get_page", arguments: '{"page_id":68}' }],
            duration_ms: 90,
          }),
          stderr: "",
          durationMs: 90n,
        });
      }, 10);
    },
  });
  const provider = new BridgeInferenceProvider(conn as never, "0xai5", { ...OLLAMA_BINDING });
  const response = await provider.chat({
    model: "catalog-model",
    maxTokens: 512,
    system: "sys",
    messages: [{ role: "user", content: "open the pear page" }],
    tools: [
      { name: "get_page", description: "read a page", input_schema: { type: "object" } },
    ],
  });

  // Request side: structured chat, no flattened prompt.
  const payload = JSON.parse(seenPayload ?? "{}");
  assert.equal(payload.prompt, undefined, "structured mode must not send a prompt");
  assert.equal(payload.model, "llama3.1:8b");
  assert.equal(payload.chat.messages[0].role, "system");
  assert.equal(payload.chat.messages[1].content, "open the pear page");
  assert.equal(payload.chat.tools[0].function.name, "get_page");

  // Response side: tool_use block with parsed (double-encoded) arguments.
  assert.equal(response.stopReason, "tool_use");
  const toolUse = response.content.find((b) => b.type === "tool_use");
  assert.ok(toolUse && toolUse.type === "tool_use");
  assert.equal(toolUse.name, "get_page");
  assert.deepEqual(toolUse.input, { page_id: 68 });
  assert.match(toolUse.id, /^bridge_/);
});

test("claude binding still sends the flattened v1 prompt payload", async () => {
  let seenPayload: string | undefined;
  const { conn } = makeConn({
    binding: BINDING,
    driveResult: (commands, results) => {
      const cmd = commands[commands.length - 1];
      seenPayload = cmd.payloadJson;
      setTimeout(() => {
        cmd.status = { tag: "Completed" };
        results.push({
          commandId: cmd.id,
          exitCode: 0,
          stdout: JSON.stringify({ ok: true, output: "x" }),
          stderr: "",
          durationMs: 1n,
        });
      }, 10);
    },
  });
  const provider = new BridgeInferenceProvider(conn as never, "0xai5", {
    mode: "bridge",
    device_id: 1,
    provider: "claude-code",
    model: "local-default",
  });
  await provider.chat({
    model: "m",
    maxTokens: 10,
    system: "sys",
    messages: [{ role: "user", content: "q" }],
    tools: [{ name: "get_page", description: "d", input_schema: {} }],
  });
  const payload = JSON.parse(seenPayload ?? "{}");
  assert.equal(payload.chat, undefined, "claude bindings must stay on the v1 prompt path");
  assert.match(payload.prompt, /Human: q/);
});

test("bridge chat fails the turn explicitly when the device is offline", async () => {
  const { conn } = makeConn({ binding: BINDING, connected: false });
  const provider = new BridgeInferenceProvider(conn as never, "0xai5", {
    mode: "bridge",
    device_id: 1,
    provider: "claude-code",
  });
  await assert.rejects(
    provider.chat({
      model: "m",
      maxTokens: 10,
      system: "",
      messages: [{ role: "user", content: "q" }],
    }),
    /offline/,
  );
});

// ── harness mode (14443) ─────────────────────────────────────────────────────

test("parseBridgeBackendBinding accepts harness mode with cwd and permission_mode", () => {
  assert.deepEqual(
    parseBridgeBackendBinding(
      '{"mode":"harness","device_id":1,"provider":"claude-code","cwd":"/Users/kara/proj","permission_mode":"acceptEdits","allowed_tools":["Bash","Edit"]}',
    ),
    {
      mode: "harness",
      device_id: 1,
      provider: "claude-code",
      model: undefined,
      cwd: "/Users/kara/proj",
      permission_mode: "acceptEdits",
      allowed_tools: ["Bash", "Edit"],
    },
  );
});

test("harnessSessionId is deterministic, per-conversation, and UUID-shaped", () => {
  const a = harnessSessionId("0xAI5", 42n);
  assert.equal(a, harnessSessionId("ai5", 42n), "0x prefix and case must not matter");
  assert.notEqual(a, harnessSessionId("ai5", 43n), "different conversation → different session");
  assert.notEqual(a, harnessSessionId("ai6", 42n), "different AI user → different session");
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("latestUserMessage takes the last human turn and skips tool results", () => {
  const messages: Message[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: "second question" },
  ];
  assert.equal(latestUserMessage(messages), "second question");
});

function makeHarnessConn(opts: {
  connected?: boolean;
  envelope: Record<string, unknown>;
}) {
  const commands: FakeCmd[] = [];
  const results: FakeRes[] = [];
  const enqueued: Array<Record<string, unknown>> = [];
  let nextId = 1n;
  const conn = {
    db: {
      bridge_device_summary: {
        iter: () => [
          {
            id: 1n,
            name: "KMBP",
            platform: "darwin-arm64",
            connected: opts.connected ?? true,
            revokedAt: null,
          },
        ],
      },
      bridge_command: { iter: () => commands },
      bridge_command_result: { iter: () => results },
    },
    reducers: {
      enqueueBridgeHarness: (args: { nonce: string; payloadJson: string; conversationId: bigint }) => {
        enqueued.push(args as unknown as Record<string, unknown>);
        const cmd: FakeCmd = {
          id: nextId++,
          deviceId: 1n,
          command: "harness:claude-code",
          conversationId: args.conversationId,
          status: { tag: "Pending" },
          nonce: args.nonce,
          payloadJson: args.payloadJson,
        };
        commands.push(cmd);
        setTimeout(() => {
          cmd.status = { tag: "Completed" };
          results.push({
            commandId: cmd.id,
            exitCode: 0,
            stdout: JSON.stringify(opts.envelope),
            stderr: "",
            durationMs: 100n,
          });
        }, 20);
      },
    },
  };
  return { conn, enqueued };
}

const HARNESS_BINDING = {
  mode: "harness",
  device_id: 1,
  provider: "claude-code",
  cwd: "/Users/kara/proj",
  permission_mode: "acceptEdits",
} as const;

test("harness turn sends only the latest message with a stable session id", async () => {
  const { conn, enqueued } = makeHarnessConn({
    envelope: { ok: true, output: "done — edited 3 files", resumed: true, session_id: "x" },
  });
  const provider = new BridgeHarnessProvider(conn as never, "0xai5", { ...HARNESS_BINDING });
  const response = await provider.chat({
    model: "m",
    maxTokens: 10,
    system: "persona",
    messages: [
      { role: "user", content: "first ask" },
      { role: "assistant", content: [{ type: "text", text: "did it" }] },
      { role: "user", content: "now run the tests" },
    ],
    conversationId: 42n,
  });
  assert.deepEqual(response.content, [{ type: "text", text: "done — edited 3 files" }]);

  const payload = JSON.parse((enqueued[0] as { payloadJson: string }).payloadJson);
  assert.equal(payload.prompt, "now run the tests", "only the latest user message travels");
  assert.equal(payload.session_id, harnessSessionId("0xai5", 42n));
  assert.equal(payload.cwd, "/Users/kara/proj");
  assert.equal(payload.permission_mode, "acceptEdits");
  assert.equal((enqueued[0] as { conversationId: bigint }).conversationId, 42n);
});

test("harness turn surfaces a context reset instead of hiding it", async () => {
  const { conn } = makeHarnessConn({
    envelope: { ok: true, output: "answer", resumed: false, session_id: "x" },
  });
  const provider = new BridgeHarnessProvider(conn as never, "0xai5", { ...HARNESS_BINDING });
  const response = await provider.chat({
    model: "m",
    maxTokens: 10,
    system: "",
    messages: [
      { role: "user", content: "earlier" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "later" },
    ],
    conversationId: 42n,
  });
  const text = response.content[0];
  assert.ok(text.type === "text");
  assert.match(text.text, /could not be resumed/);
  assert.match(text.text, /answer/);
});

test("harness turn fails loud when the device is offline", async () => {
  const { conn } = makeHarnessConn({ connected: false, envelope: { ok: true, output: "" } });
  const provider = new BridgeHarnessProvider(conn as never, "0xai5", { ...HARNESS_BINDING });
  await assert.rejects(
    provider.chat({
      model: "m",
      maxTokens: 10,
      system: "",
      messages: [{ role: "user", content: "q" }],
      conversationId: 1n,
    }),
    /offline/,
  );
});

test("bridge chat surfaces a provider failure instead of fabricating an answer", async () => {
  const { conn } = makeConn({
    binding: BINDING,
    driveResult: (commands, results) => {
      const cmd = commands[commands.length - 1];
      setTimeout(() => {
        cmd.status = { tag: "Completed" };
        results.push({
          commandId: cmd.id,
          exitCode: 1,
          stdout: JSON.stringify({ ok: false, error: "claude not logged in" }),
          stderr: "",
          durationMs: 2n,
        });
      }, 10);
    },
  });
  const provider = new BridgeInferenceProvider(conn as never, "0xai5", {
    mode: "bridge",
    device_id: 1,
    provider: "claude-code",
  });
  await assert.rejects(
    provider.chat({
      model: "m",
      maxTokens: 10,
      system: "",
      messages: [{ role: "user", content: "q" }],
    }),
    /not logged in/,
  );
});
