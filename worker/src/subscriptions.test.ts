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
