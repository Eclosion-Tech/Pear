import { test } from "node:test";
import assert from "node:assert/strict";

import {
  streamTokenBudget,
  userVisibleTurnFailure,
} from "./conversation.js";

test("stream token budget only adds Anthropic's explicit thinking allowance", () => {
  assert.deepEqual(streamTokenBudget("Anthropic", 8192), {
    maxTokens: 13192,
    thinkingBudget: 5000,
  });
  assert.deepEqual(streamTokenBudget("OpenRouter", 8192), {
    maxTokens: 8192,
  });
  assert.deepEqual(streamTokenBudget("OpenAi", 8192), {
    maxTokens: 8192,
  });
});

test("an adaptive-thinking Anthropic model gets room to reason and still answer", () => {
  for (const model of ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"]) {
    assert.deepEqual(streamTokenBudget("Anthropic", 8192, model), {
      maxTokens: 64000,
      thinkingBudget: 5000,
    });
  }
  // A configured limit above the floor is kept, with the allowance on top.
  assert.deepEqual(streamTokenBudget("Anthropic", 100000, "claude-opus-4-8"), {
    maxTokens: 105000,
    thinkingBudget: 5000,
  });
});

test("a fixed-budget or unknown Anthropic model keeps the configured limit plus its budget", () => {
  for (const model of ["claude-haiku-4-5-20251001", "some-custom-model"]) {
    assert.deepEqual(streamTokenBudget("Anthropic", 8192, model), {
      maxTokens: 13192,
      thinkingBudget: 5000,
    });
  }
});

test("an OpenRouter catalog model gets room to reason, with the configured limit to fall back to", () => {
  for (const model of ["z-ai/glm-5.3", "z-ai/glm-5.3-flash", "anthropic/claude-fable-5", "openai/gpt-5.6-sol"]) {
    assert.deepEqual(streamTokenBudget("OpenRouter", 8192, model), {
      maxTokens: 64000,
      fallbackMaxTokens: 8192,
    });
  }
});

test("an OpenRouter model outside the catalog keeps the configured limit", () => {
  assert.deepEqual(streamTokenBudget("OpenRouter", 8192, "some-vendor/unlisted-model"), {
    maxTokens: 8192,
  });
});

test("a configured limit at or above the ceiling is sent as it is", () => {
  assert.deepEqual(streamTokenBudget("OpenRouter", 64000, "z-ai/glm-5.3"), { maxTokens: 64000 });
  assert.deepEqual(streamTokenBudget("OpenRouter", 100000, "z-ai/glm-5.3"), { maxTokens: 100000 });
});

test("other OpenAI-compatible providers keep the configured limit whatever the model", () => {
  assert.deepEqual(streamTokenBudget("OpenAi", 8192, "gpt-5.6"), { maxTokens: 8192 });
  assert.deepEqual(streamTokenBudget("OpenAiCompatible", 8192, "z-ai/glm-5.3"), { maxTokens: 8192 });
  assert.deepEqual(streamTokenBudget("Ollama", 8192, "llama3"), { maxTokens: 8192 });
});

test("a 402 provider failure tells the user the account is out of credit", () => {
  const message = userVisibleTurnFailure(Object.assign(new Error("Provider returned error"), {
    status: 402,
  }));
  assert.match(message, /lack of credit \(402\)/);
  assert.doesNotMatch(message, /credentials/);
});

test("429 provider failures become a visible retry/switch message", () => {
  const message = userVisibleTurnFailure(Object.assign(new Error("Provider returned error"), {
    status: 429,
  }));
  assert.match(message, /overloaded \(429\)/);
  assert.match(message, /Retry/);
  assert.match(message, /switch models/);
});

test("429 is detected when an adapter only includes it in the message", () => {
  assert.match(userVisibleTurnFailure(new Error("429 Provider returned error")), /overloaded/);
});

test("provider authentication failures point to settings without echoing raw details", () => {
  const message = userVisibleTurnFailure(
    Object.assign(new Error("401 invalid x-api-key sk-sensitive-value"), { status: 401 }),
  );
  assert.match(message, /provider and API-key settings/);
  assert.doesNotMatch(message, /sk-sensitive-value/);
});

test("unknown failures use a safe generic message", () => {
  const message = userVisibleTurnFailure(new Error("internal secret-bearing response body"));
  assert.match(message, /provider or worker returned an error/);
  assert.doesNotMatch(message, /secret-bearing/);
});
