import { test } from "node:test";
import assert from "node:assert/strict";
import { answerRecoveryRequest, isThinkingOnlyExhaustion, emptyAnswerMessage } from "./thinking-recovery.js";
import { createProviderFromConfig, type ChatStreamRequest } from "./providers.js";

const request: ChatStreamRequest = {
  model: "claude-sonnet-4-6", maxTokens: 13192, thinkingBudget: 5000, effort: "high",
  system: "system", messages: [{ role: "user", content: "hello" }],
  tools: [{ name: "lookup", description: "lookup", input_schema: { type: "object" } }],
};

test("only empty length-limited responses qualify; partial text and tools never replay", () => {
  const response = { stopReason: "max_tokens", content: [] };
  assert.equal(isThinkingOnlyExhaustion(response, "", false), true);
  assert.equal(isThinkingOnlyExhaustion(response, "partial answer", false), false);
  assert.equal(isThinkingOnlyExhaustion(response, "", true), false);
  assert.equal(isThinkingOnlyExhaustion({ ...response, stopReason: "end_turn" }, "", false), false);
  assert.equal(isThinkingOnlyExhaustion({ ...response, content: [{ type: "tool_use", id: "1", name: "lookup", input: {} }] }, "", false), false);
  assert.equal(isThinkingOnlyExhaustion({ ...response, content: [{ type: "text", text: "answer" }] }, "", false), false);
});

test("recovery keeps tool history, tool definitions, and output allowance unchanged", () => {
  const retry = answerRecoveryRequest(request, "Anthropic")!;
  assert.equal(retry.messages, request.messages);
  assert.equal(retry.tools, request.tools);
  assert.equal(retry.maxTokens, request.maxTokens);
  assert.equal(retry.effort, undefined);
  assert.equal(retry.thinkingBudget, undefined);
  assert.equal(request.effort, "high");
});

test("Anthropic adapter actually omits adaptive thinking on recovery", async () => {
  const provider = createProviderFromConfig({ id: 1n, provider: { tag: "Anthropic" }, apiKey: "test-key", identity: { toHexString: () => "test" }, createdBy: { toHexString: () => "test" }, endpoint: undefined, systemPrompt: undefined, model: request.model, maxTokens: request.maxTokens });
  const params: Record<string, unknown>[] = [];
  (provider as any).client = { messages: { stream: (arg: Record<string, unknown>) => {
    params.push(arg);
    return {
      async *[Symbol.asyncIterator]() {},
      async finalMessage() { return { content: [{ type: "text", text: "answer" }], stop_reason: "end_turn", usage: {} }; },
    };
  } } };
  for await (const _ of provider.chatStream!(request)) { /* drain */ }
  for await (const _ of provider.chatStream!(answerRecoveryRequest(request, "Anthropic")!)) { /* drain */ }
  assert.deepEqual(params[0].thinking, { type: "adaptive" });
  assert.equal(params[1].thinking, undefined);
  assert.equal(params[1].output_config, undefined);
});

test("unsupported model recovery is skipped instead of sending unknown effort settings", () => {
  assert.equal(answerRecoveryRequest({ ...request, model: "unknown-model" }, "OpenAiCompatible"), undefined);
});

test("empty answers explain length exhaustion separately from other empty completions", () => {
  assert.match(emptyAnswerMessage(true), /length limit/);
  assert.doesNotMatch(emptyAnswerMessage(false), /length limit/);
});

test("known OpenAI reasoning models recover using the catalog's lowest effort", () => {
  const retry = answerRecoveryRequest({ ...request, model: "gpt-5.6" }, "OpenAi")!;
  assert.equal(retry.effort, "none");
  assert.equal(retry.maxTokens, request.maxTokens);
  assert.equal(retry.messages, request.messages);
});
