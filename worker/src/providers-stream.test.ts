import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProvider,
  type InferenceProvider,
  type StreamEvent,
} from "./providers.js";

/** Fake chat-completions chunks in the shape the OpenAI SDK yields. */
type FakeChunk = {
  choices: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

function providerWithChunks(chunks: FakeChunk[]): InferenceProvider {
  const provider = createProvider(
    "OpenAiCompatible",
    "https://openrouter.ai/api/v1",
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).client = {
    chat: {
      completions: {
        create: async (params: { stream?: boolean }) => {
          assert.equal(params.stream, true, "chatStream must request streaming");
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    },
  };
  return provider;
}

function ofType<T extends StreamEvent["type"]>(
  events: StreamEvent[],
  type: T,
): Extract<StreamEvent, { type: T }>[] {
  return events.filter((e): e is Extract<StreamEvent, { type: T }> => e.type === type);
}

function lastDone(events: StreamEvent[]): Extract<StreamEvent, { type: "done" }> {
  const done = events.at(-1);
  if (!done || done.type !== "done") {
    throw new Error(`expected final event to be done, got ${done?.type}`);
  }
  return done;
}

async function collect(provider: InferenceProvider): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of provider.chatStream!({
    model: "moonshotai/kimi-k3",
    maxTokens: 128,
    system: "test",
    messages: [{ role: "user", content: "hi" }],
  })) {
    events.push(ev);
  }
  return events;
}

test("OpenAI-compatible chatStream exists (OpenRouter users get streaming)", () => {
  const provider = createProvider(
    "OpenAiCompatible",
    "https://openrouter.ai/api/v1",
  );
  assert.equal(typeof provider.chatStream, "function");
});

test("chatStream yields text deltas and a done response with usage", async () => {
  const events = await collect(
    providerWithChunks([
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
    ]),
  );

  assert.deepEqual(
    ofType(events, "text_delta").map((e) => e.text),
    ["Hel", "lo"],
  );
  const done = lastDone(events);
  assert.equal(done.response.stopReason, "end_turn");
  assert.deepEqual(done.response.content, [{ type: "text", text: "Hello" }]);
  assert.deepEqual(done.response.usage, {
    inputTokens: 10,
    outputTokens: 2,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 4,
  });
});

test("chatStream maps OpenRouter reasoning deltas to thinking", async () => {
  const events = await collect(
    providerWithChunks([
      { choices: [{ delta: { reasoning: "hmm " } }] },
      { choices: [{ delta: { reasoning: "ok" } }] },
      { choices: [{ delta: { content: "Answer" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]),
  );

  assert.deepEqual(
    ofType(events, "thinking_delta").map((e) => e.text),
    ["hmm ", "ok"],
  );
  assert.equal(lastDone(events).response.thinking, "hmm ok");
});

test("chatStream accumulates fragmented tool-call args and maps tool_calls stop", async () => {
  const events = await collect(
    providerWithChunks([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", function: { name: "search_pages", arguments: "" } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"kimi"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]),
  );

  const starts = ofType(events, "tool_use_start");
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].block, {
    type: "tool_use",
    id: "call_a",
    name: "search_pages",
    input: { query: "kimi" },
  });

  const done = lastDone(events);
  assert.equal(done.response.stopReason, "tool_use");
  assert.deepEqual(done.response.content, [starts[0].block]);
});

test("chatStream emits earlier tool call live when a new index starts", async () => {
  const events = await collect(
    providerWithChunks([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", function: { name: "get_page", arguments: '{"page_id":1}' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              // New index → index 0 is complete and should be emitted before
              // the stream ends.
              tool_calls: [
                { index: 1, id: "call_b", function: { name: "get_page", arguments: '{"page_id":2}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]),
  );

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["tool_use_start", "tool_use_start", "done"]);
  const done = lastDone(events);
  assert.deepEqual(
    done.response.content.map((b) => (b.type === "tool_use" ? b.id : "?")),
    ["call_a", "call_b"],
  );
});

test("chatStream tolerates malformed tool args", async () => {
  const events = await collect(
    providerWithChunks([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", function: { name: "broken", arguments: "{not json" } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]),
  );

  const [start] = ofType(events, "tool_use_start");
  assert.ok(start);
  assert.deepEqual(start.block.input, {});
});
