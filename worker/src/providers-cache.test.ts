import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getProviderForAiUser,
  invalidateProviderCache,
} from "./providers.js";

type TestConfig = {
  id: bigint;
  provider: { tag: "OpenAiCompatible" };
  model: string;
  endpoint: string;
  apiKey: string;
  maxTokens: number;
};

function testConnection(config: TestConfig) {
  return {
    db: {
      ai_user_config: {
        id: {
          find: () => config,
        },
      },
    },
  };
}

test("provider cache is isolated between workspace connections with the same AI-user ID", () => {
  const first = testConnection({
    id: 1n,
    provider: { tag: "OpenAiCompatible" },
    model: "first-workspace-model",
    endpoint: "https://openrouter.ai/api/v1",
    apiKey: "first-key",
    maxTokens: 1024,
  });
  const second = testConnection({
    id: 1n,
    provider: { tag: "OpenAiCompatible" },
    model: "second-workspace-model",
    endpoint: "https://openrouter.ai/api/v1",
    apiKey: "second-key",
    maxTokens: 2048,
  });

  assert.equal(getProviderForAiUser(first, 1n).model, "first-workspace-model");
  assert.equal(getProviderForAiUser(second, 1n).model, "second-workspace-model");
});

test("invalidating a config update rebuilds only that connection's provider", () => {
  const config: TestConfig = {
    id: 7n,
    provider: { tag: "OpenAiCompatible" },
    model: "before-rotation",
    endpoint: "https://openrouter.ai/api/v1",
    apiKey: "old-key",
    maxTokens: 1024,
  };
  const conn = testConnection(config);

  assert.equal(getProviderForAiUser(conn, 7n).model, "before-rotation");
  config.model = "after-rotation";
  assert.equal(getProviderForAiUser(conn, 7n).model, "before-rotation");

  invalidateProviderCache(conn, 7n);

  assert.equal(getProviderForAiUser(conn, 7n).model, "after-rotation");
});
