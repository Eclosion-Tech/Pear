import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BridgeInferenceProvider,
  parseBridgeBackendBinding,
  renderTranscript,
} from "./bridge-inference.ts";
import { getProviderForAiUser, invalidateProviderCache } from "./providers.ts";
import type { Message } from "./providers.ts";

test("parseBridgeBackendBinding accepts bridge mode and rejects everything else", () => {
  assert.deepEqual(
    parseBridgeBackendBinding('{"mode":"bridge","device_id":1,"provider":"claude-code","model":"m"}'),
    { mode: "bridge", device_id: 1, provider: "claude-code", model: "m" },
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
