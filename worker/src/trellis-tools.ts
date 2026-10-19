import type Anthropic from "@anthropic-ai/sdk";
import { canonicalJson, sha256, type JsonObject } from "@eclosion-tech/trellis";
import {
  createSavedUi,
  updateSavedUi,
  readSavedUi,
  TEMPLATES,
  defaultParameters,
  type SavedUi,
} from "@pear/trellis-ui";

const names = new Set([
  "list_ui_templates",
  "list_ui",
  "get_ui",
  "create_ui",
  "update_ui",
]);
export const isTrellisTool = (name: string) => names.has(name);
const requestId = {
  type: "string",
  description:
    "Unique stable request ID. Reuse the same ID and identical arguments when retrying an uncertain commit.",
};
const messageId = {
  type: "string",
  description:
    "Decimal assistant message ID in this conversation. Use get_ui to read its current revision first.",
};
export const TRELLIS_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "list_ui_templates",
    description:
      "List the host-bundled, versioned Trellis templates and their parameter schemas. Start here for a retained interface. Templates contain no business-action authority.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "list_ui",
    description:
      "Find up to 20 recent retained interfaces in this conversation, including earlier turns. Returns message IDs and saved revisions so you can get_ui and update_ui without recreating a screen. Does not expose unsent browser drafts.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_ui",
    description:
      "Read a retained interface from this conversation: pinned template, saved parameters and current revision. Local user drafts are private to the browser and are not returned. If message_id is omitted, read your current message.",
    input_schema: {
      type: "object",
      properties: { message_id: messageId },
      additionalProperties: false,
    },
  },
  {
    name: "create_ui",
    description:
      "Create one retained interface on your current assistant message. Select an exact bundled template version and supply parameters. The automation-form requires an existing Manual automation ID and explicit input mappings; $form.value reads its single required field. Pear authorizes actual execution when the user clicks. A saved result means the document was observed in the database, not that an automation ran. Use a fresh message if another panel already occupies this one.",
    input_schema: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          enum: ["pear.summary", "pear.automation-form"],
        },
        template_version: { type: "string", enum: ["1.0.0"] },
        parameters: { type: "object" },
        automation: {
          type: "object",
          properties: {
            automationId: { type: "string" },
            input: { type: "object" },
            confirmation: { type: "string" },
          },
          required: ["automationId", "input"],
          additionalProperties: false,
        },
        request_id: requestId,
      },
      required: ["template_id", "template_version", "parameters", "request_id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_ui",
    description:
      "Update parameters on the SAME saved interface, including an earlier message authored by you in this conversation. Read with get_ui first; pass its base_revision. Omitted parameters retain their values. Node IDs and dirty user input survive. Template version and action bindings cannot change. On STALE_REVISION read again and decide whether to retry with a new request ID. Never substitute render_ui, which cannot overwrite a retained interface.",
    input_schema: {
      type: "object",
      properties: {
        message_id: messageId,
        base_revision: { type: "integer", minimum: 0 },
        parameters: { type: "object" },
        request_id: requestId,
      },
      required: ["message_id", "base_revision", "parameters", "request_id"],
      additionalProperties: false,
    },
  },
];
type Row = {
  id: bigint;
  conversationId: bigint;
  componentTreeJson?: unknown;
  createdAt?: { microsSinceUnixEpoch: bigint };
};
export type TrellisConnection = {
  db: {
    conversation_message: { iter(): Iterable<Row> };
    automation_rule?: {
      iter(): Iterable<{
        id: bigint;
        enabled: boolean;
        triggerKind: { tag: string };
      }>;
    };
  };
  reducers: {
    commitMessageTrellis?: (args: {
      messageId: bigint;
      baseRevision?: bigint;
      requestId: string;
      intentJson: string;
      payloadJson: string;
    }) => unknown;
  };
};
type Context = { conversationId?: bigint; messageId?: bigint };
function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}
function rawString(raw: unknown): string | null {
  if (typeof raw === "string") return raw || null;
  if (
    raw &&
    typeof raw === "object" &&
    "tag" in raw &&
    raw.tag === "some" &&
    "value" in raw &&
    typeof raw.value === "string"
  )
    return raw.value || null;
  return null;
}
function targetId(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    fail("INVALID_INPUT", "Expected a positive decimal message ID.");
  return BigInt(value);
}
function parameters(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_INPUT", "Parameters must be an object.");
  canonicalJson(value);
  return value as JsonObject;
}
function result(saved: SavedUi, id: bigint, receiptRevision?: number) {
  return {
    ok: true,
    saved: true,
    message_id: String(id),
    revision: saved.document.revision,
    ...(receiptRevision === undefined
      ? {}
      : { committed_revision: receiptRevision }),
    template_id: saved.document.template!.id,
    template_version: saved.document.template!.version,
    parameters: saved.document.template!.parameters,
    bindings: saved.bindings,
    keys: saved.document.nodes.flatMap((n) => (n.key ? [n.key] : [])),
  };
}
export async function executeTrellisTool(
  conn: TrellisConnection,
  name: string,
  input: Record<string, unknown>,
  context: Context,
  options: { enabled: boolean; timeoutMs?: number },
): Promise<Record<string, unknown>> {
  try {
    if (!options.enabled)
      fail(
        "FEATURE_DISABLED",
        "Retained UI tools are not enabled for this worker.",
      );
    if (!isTrellisTool(name)) fail("UNKNOWN_TOOL", "Unknown retained UI tool.");
    const definition = TRELLIS_TOOLS.find((t) => t.name === name)!;
    const allowed = Object.keys(definition.input_schema.properties ?? {});
    if (Object.keys(input).some((k) => !allowed.includes(k)))
      fail("INVALID_INPUT", "Unexpected tool arguments.");
    canonicalJson(input);
    if (name === "list_ui_templates")
      return {
        ok: true,
        templates: TEMPLATES.map((t) => ({
          id: t.id,
          version: t.version,
          hash: t.hash,
          description: t.description,
          parameters: t.parameters,
          defaults: defaultParameters(t),
          action_slots: t.actionSlots,
        })),
      };
    if (!context.conversationId || !context.messageId)
      fail(
        "CHAT_REQUIRED",
        "Retained interfaces are available only during a conversation turn.",
      );
    if (name === "list_ui") {
      const rows = [...conn.db.conversation_message.iter()].filter(
        (row) => row.conversationId === context.conversationId,
      );
      rows.sort((a, b) => {
        const first = a.createdAt?.microsSinceUnixEpoch ?? 0n;
        const second = b.createdAt?.microsSinceUnixEpoch ?? 0n;
        return first === second
          ? a.id < b.id
            ? 1
            : -1
          : first < second
            ? 1
            : -1;
      });
      const interfaces = [];
      for (const row of rows) {
        const raw = rawString(row.componentTreeJson);
        if (!raw) continue;
        try {
          const saved = readSavedUi(raw, row.id);
          interfaces.push({
            message_id: String(row.id),
            revision: saved.document.revision,
            template_id: saved.document.template!.id,
            template_version: saved.document.template!.version,
            title: saved.document.template!.parameters.title,
          });
        } catch {
          /* Historical content is not a retained template instance. */
        }
        if (interfaces.length === 20) break;
      }
      return { ok: true, interfaces };
    }
    const id =
      name === "create_ui"
        ? context.messageId
        : input.message_id === undefined
          ? context.messageId
          : targetId(input.message_id);
    const row = () =>
      [...conn.db.conversation_message.iter()].find(
        (m) => m.id === id && m.conversationId === context.conversationId,
      );
    const currentRow = row();
    if (!currentRow)
      fail("MESSAGE_NOT_FOUND", "Message is not visible in this conversation.");
    const raw = rawString(currentRow.componentTreeJson);
    let current: SavedUi | undefined;
    if (raw) {
      try {
        current = readSavedUi(raw, id);
      } catch {
        fail(
          "UI_OCCUPIED",
          "This message contains an incompatible interface; it will not be overwritten.",
        );
      }
    }
    if (name === "get_ui")
      return current
        ? result(current, id)
        : { ok: true, message_id: String(id), interface: null };
    if (
      typeof input.request_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.request_id)
    )
      fail("INVALID_INPUT", "A bounded stable request_id is required.");
    const intent = { tool: name, messageId: String(id), arguments: input };
    const intentJson = canonicalJson(intent);
    if (new TextEncoder().encode(intentJson).length > 16000)
      fail("INVALID_INPUT", "Interface request is too large.");
    const intentHash = await sha256(intent);
    const receipt = current?.receipts.find(
      (r) => r.requestId === input.request_id,
    );
    if (receipt) {
      if (receipt.intentHash !== intentHash)
        fail(
          "REQUEST_REUSED",
          "This request ID was used with different arguments.",
        );
      return { ...result(current!, id, receipt.revision), replayed: true };
    }
    let baseRevision: bigint | undefined;
    let payload;
    if (name === "create_ui") {
      if (current)
        fail("UI_OCCUPIED", "Use update_ui to change this retained interface.");
      if (
        typeof input.template_id !== "string" ||
        typeof input.template_version !== "string"
      )
        fail("INVALID_INPUT", "An exact template ID and version are required.");
      payload = await createSavedUi(
        id,
        input.template_id,
        input.template_version,
        parameters(input.parameters),
        input.automation,
      );
      if (payload.bindings.submit) {
        const id = BigInt(payload.bindings.submit.automationId);
        const rule =
          conn.db.automation_rule &&
          [...conn.db.automation_rule.iter()].find((rule) => rule.id === id);
        if (!rule || !rule.enabled || rule.triggerKind.tag !== "Manual")
          fail(
            "INVALID_AUTOMATION",
            "The form must reference an existing enabled Manual automation.",
          );
      }
    } else {
      if (!current)
        fail("UI_NOT_FOUND", "No retained interface exists on this message.");
      if (
        !Number.isSafeInteger(input.base_revision) ||
        (input.base_revision as number) < 0
      )
        fail("INVALID_INPUT", "A safe integer base_revision is required.");
      if (input.base_revision !== current.document.revision)
        return {
          ok: false,
          code: "STALE_REVISION",
          error: "Read the saved interface again before updating it.",
          message_id: String(id),
          revision: current.document.revision,
        };
      baseRevision = BigInt(input.base_revision as number);
      payload = await updateSavedUi(
        current,
        parameters(input.parameters),
        input.request_id,
      );
    }
    const commit = conn.reducers.commitMessageTrellis;
    if (!commit)
      fail(
        "BACKEND_NOT_READY",
        "The commit_message_trellis reducer is unavailable; update the local module before enabling the tools.",
      );
    let commitError: unknown;
    try {
      await commit.call(conn.reducers, {
        messageId: id,
        baseRevision,
        requestId: input.request_id,
        intentJson,
        payloadJson: canonicalJson(payload),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /\b(?:STALE_REVISION|REQUEST_REUSED|TEMPLATE_PINNED|INVALID_UI|UI_LIMIT|UI_OCCUPIED):/.test(
          message,
        )
      )
        throw error;
      if (
        /Only the original sender|Cannot update a (?:human|system) message|Conversation is closed|lacks .*access|not authorized/i.test(
          message,
        )
      )
        fail("AUTHORIZATION_DENIED", message);
      // A lost acknowledgement can follow a committed reducer. Observe its
      // receipt before deciding whether the caller needs an identical retry.
      commitError = error;
    }
    const deadline = Date.now() + (options.timeoutMs ?? 3000);
    do {
      const observed = rawString(row()?.componentTreeJson);
      if (observed) {
        const saved = readSavedUi(observed, id);
        const committed = saved.receipts.find(
          (r) => r.requestId === input.request_id,
        );
        if (committed) {
          if (committed.intentHash !== intentHash)
            fail(
              "REQUEST_REUSED",
              "This request ID was committed with different arguments.",
            );
          return result(saved, id, committed.revision);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return {
      ok: false,
      code: "COMMIT_UNCONFIRMED",
      error:
        "The commit is not yet visible. Retry with the same request_id and identical arguments; do not claim it was saved.",
      ...(commitError
        ? {
            transport_error:
              commitError instanceof Error
                ? commitError.message
                : String(commitError),
          }
        : {}),
      message_id: String(id),
      request_id: input.request_id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.match(/\b([A-Z][A-Z_]+):/)?.[1] ?? "INVALID_UI";
    return { ok: false, code, error: message };
  }
}
