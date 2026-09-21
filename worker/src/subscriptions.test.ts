import { test } from "node:test";
import assert from "node:assert/strict";
import { subscribeToAvailableTables } from "./subscriptions.js";

test("ai_user_config has a dedicated subscription for credential rotations", () => {
  const subscriptions: string[][] = [];
  const connection = {
    subscriptionBuilder() {
      const builder = {
        onApplied(_cb: () => void) {
          return builder;
        },
        onError(_cb: (_ctx: unknown, err: unknown) => void) {
          return builder;
        },
        subscribe(queries: string[]) {
          subscriptions.push(queries);
        },
      };
      return builder;
    },
  };

  subscribeToAvailableTables(connection, "[test]", () => undefined);

  assert.ok(
    subscriptions.some(
      (queries) =>
        queries.length === 1 && queries[0] === "SELECT * FROM ai_user_config",
    ),
    "expected an isolated ai_user_config query set",
  );
});

test("a rejected human-input subscription does not block chat subscription readiness", () => {
  let ready = 0;
  const applied: string[][] = [];
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  const connection = {
    subscriptionBuilder() {
      let onApplied = () => {};
      let onError = (_ctx: unknown, _err: unknown) => {};
      const builder = {
        onApplied(cb: () => void) { onApplied = cb; return builder; },
        onError(cb: (_ctx: unknown, err: unknown) => void) { onError = cb; return builder; },
        subscribe(queries: string[]) {
          if (queries.includes("SELECT * FROM human_input_request")) {
            onError({}, new Error("Subscriptions require indexes on join columns"));
          } else {
            applied.push(queries);
            onApplied();
          }
        },
      };
      return builder;
    },
  };
  try {
    subscribeToAvailableTables(connection, "[test]", () => { ready++; });
    assert.equal(ready, 1, "the main subscription must still trigger pending-message catch-up");
    assert.ok(applied.some(queries => ["conversation", "conversation_message", "conversation_participant", "page", "ai_user_config"]
      .every(name => queries.includes(`SELECT * FROM ${name}`))), "chat context must remain available together");
    assert.ok(errors.some(args => args.join(" ").includes("human input subscription error")), "the auxiliary failure must remain visible");
  } finally {
    console.error = originalError;
  }
});
