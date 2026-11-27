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

test("the ceiling for other providers does not depend on the model", () => {
  assert.deepEqual(streamTokenBudget("OpenRouter", 8192, "anthropic/claude-fable-5"), {
    maxTokens: 8192,
  });
  assert.deepEqual(streamTokenBudget("OpenAi", 8192, "gpt-5.6"), {
    maxTokens: 8192,
  });
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
