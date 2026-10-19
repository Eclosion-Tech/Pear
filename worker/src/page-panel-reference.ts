import { canonicalJson } from "@eclosion-tech/trellis";
import {
  getPagePanel,
  pagePanelResult,
} from "../../web/src/lib/mcp/page-panels.js";
import type { ConnLike, ToolCallContext } from "./tools.js";
import type { StdbTransport } from "../../web/src/lib/mcp/types.js";
import { unwrapScalar } from "../../web/src/lib/api-endpoint/codec.js";

export async function showPagePanel(
  conn: ConnLike,
  input: Record<string, unknown>,
  context: ToolCallContext,
  transport?: StdbTransport,
): Promise<string> {
  try {
    if (
      Object.keys(input).length !== 1 ||
      typeof input.component_id !== "string"
    )
      throw new Error("Pass only component_id as a decimal string.");
    if (!context.messageId || !context.conversationId || !context.aiIdentityHex)
      throw new Error(
        "A page-panel reference requires an authenticated assistant turn.",
      );
    if (!transport)
      throw new Error("The authenticated page transport is unavailable.");
    if (typeof conn.reducers.setMessagePageComponent !== "function")
      return JSON.stringify({
        ok: false,
        code: "BACKEND_NOT_READY",
        error:
          "Install the page-panel module and bindings before showing a live reference.",
      });
    const panel = await getPagePanel(transport, input.component_id);
    const result = pagePanelResult(panel);
    const reference = canonicalJson(result.reference);
    const read = async () => {
      const rows = await transport.sql<{
        conversation_id: unknown;
        component_tree_json: unknown;
      }>(
        `SELECT conversation_id, component_tree_json FROM conversation_message WHERE id = ${context.messageId}`,
      );
      if (
        !rows[0] ||
        String(rows[0].conversation_id) !== String(context.conversationId)
      )
        throw new Error(
          "The current assistant message is unavailable in this conversation.",
        );
      return unwrapScalar(rows[0].component_tree_json);
    };
    const current = await read();
    if (current && current !== reference)
      return JSON.stringify({
        ok: false,
        code: "UI_OCCUPIED",
        error: "Use a fresh assistant message for this page-panel reference.",
      });
    let acknowledgement: unknown;
    try {
      await conn.reducers.setMessagePageComponent({
        messageId: String(context.messageId),
        componentId: panel.componentId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /UI_OCCUPIED|original sender|closed|lacks .*access|not found|INVALID_PAGE_PANEL/i.test(
          message,
        )
      )
        throw error;
      acknowledgement = error;
    }
    const deadline = Date.now() + 3000;
    do {
      try {
        if ((await read()) === reference)
          return JSON.stringify({
            ...result,
            shown: true,
            message_id: String(context.messageId),
          });
      } catch (error) {
        acknowledgement ??= error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return JSON.stringify({
      ok: false,
      code: "COMMIT_UNCONFIRMED",
      error:
        "The reference was not observed. Retry show_page_panel for the same component." +
        (acknowledgement instanceof Error ? " " + acknowledgement.message : ""),
    });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
