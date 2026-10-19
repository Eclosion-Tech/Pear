import { test } from "node:test";
import assert from "node:assert/strict";
import { createSavedUi, readSavedUi, updateSavedUi } from "@pear/trellis-ui";
import { executeTrellisTool } from "./trellis-tools.js";

test("retained template parameters roundtrip without changing identities or bindings", async () => {
  const created = await createSavedUi(
    123n,
    "pear.automation-form",
    "1.0.0",
    { title: "A saved command" },
    {
      automationId: "17",
      input: { value: "$form.value" },
      confirmation: "Run this command?",
    },
  );
  const saved = readSavedUi(JSON.stringify({ ...created, receipts: [] }), 123n);
  const updated = await updateSavedUi(
    saved,
    { title: "An updated command" },
    "update-1",
  );
  assert.deepEqual(
    updated.document.nodes.map((n) => n.id),
    created.document.nodes.map((n) => n.id),
  );
  assert.deepEqual(updated.bindings, created.bindings);
  assert.equal(updated.document.revision, 1);
  const forged = JSON.parse(JSON.stringify({ ...updated, receipts: [] }));
  forged.document.nodes[1].text = [{ text: "Forged content" }];
  assert.throws(
    () => readSavedUi(JSON.stringify(forged), 123n),
    /pinned template/,
  );
});
test("worker tools enforce feature/conversation scope before committing", async () => {
  let writes = 0;
  const conn = {
    db: {
      conversation_message: { iter: () => [{ id: 123n, conversationId: 7n }] },
    },
    reducers: {
      commitMessageTrellis() {
        writes++;
      },
    },
  };
  const context = { conversationId: 7n, messageId: 123n };
  assert.equal(
    (
      await executeTrellisTool(conn, "list_ui_templates", {}, context, {
        enabled: false,
      })
    ).code,
    "FEATURE_DISABLED",
  );
  assert.equal(
    (
      await executeTrellisTool(
        conn,
        "get_ui",
        { message_id: "123" },
        { ...context, conversationId: 8n },
        { enabled: true },
      )
    ).code,
    "MESSAGE_NOT_FOUND",
  );
  assert.equal(writes, 0);
});
test("an acknowledgement without an observed receipt is not a saved result", async () => {
  const conn = {
    db: {
      conversation_message: { iter: () => [{ id: 123n, conversationId: 7n }] },
    },
    reducers: { commitMessageTrellis() {} },
  };
  const result = await executeTrellisTool(
    conn,
    "create_ui",
    {
      request_id: "first",
      template_id: "pear.summary",
      template_version: "1.0.0",
      parameters: { title: "A summary" },
    },
    { conversationId: 7n, messageId: 123n },
    { enabled: true, timeoutMs: 1 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "COMMIT_UNCONFIRMED");
  assert.equal(result.saved, undefined);
});
