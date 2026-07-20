import { test } from "node:test";
import assert from "node:assert/strict";

import { userVisibleTurnFailure } from "./conversation.js";

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
