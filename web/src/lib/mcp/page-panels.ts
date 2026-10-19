import { canonicalJson, sha256 } from "@eclosion-tech/trellis";
import {
  PAGE_PANEL_TYPE,
  PAGE_PANEL_TEMPLATE,
  PAGE_PANEL_DEFAULTS,
  readPagePanel,
  panelId,
  panelRequestId,
  panelChanges,
  commitObservedPagePanel,
  PanelCommitError,
  type PagePanel,
} from "@pear/trellis-ui";
import type { McpContext, McpToolEntry, StdbTransport } from "./types.js";
import { isOptionNone } from "../api-endpoint/codec.js";
import { reducerErrorMessage } from "./errors.js";

type RawNode = {
  id: unknown;
  surface_id: unknown;
  component_type: string;
  props: string;
  deleted_at: unknown;
};
function fail(code: string, message: string): never {
  throw new PanelCommitError(code, message);
}
function exact(input: Record<string, unknown>, fields: string[]) {
  if (Object.keys(input).some((key) => !fields.includes(key)))
    fail("INVALID_INPUT", "Unexpected page-panel arguments.");
}
function sqlId(raw: unknown): string {
  if (typeof raw === "number" && !Number.isSafeInteger(raw))
    fail("UNSAFE_ID", "The database transport rounded an opaque ID.");
  return panelId(String(raw));
}
function identity(raw: unknown): string {
  if (Array.isArray(raw) && raw.length === 1) return identity(raw[0]);
  if (raw && typeof raw === "object") {
    const row = raw as Record<string, unknown>;
    return identity(row.__identity__ ?? row.identity ?? row.value);
  }
  if (typeof raw !== "string" || !/^(0x)?[a-f0-9]{64}$/i.test(raw))
    fail("AUTHORIZATION_DENIED", "Caller identity is unavailable.");
  return raw.replace(/^0x/i, "").toLowerCase();
}
async function caller(ctx: McpContext): Promise<string> {
  const rows = await ctx.transport.sql<{ identity: unknown }>(
    `SELECT identity FROM ai_user_config WHERE id = ${ctx.aiUserId}`,
  );
  if (rows.length !== 1)
    fail("AUTHORIZATION_DENIED", "Caller AI identity is unavailable.");
  return identity(rows[0].identity);
}
async function rawNode(transport: StdbTransport, id: string): Promise<RawNode> {
  panelId(id);
  const rows = await transport.sql<RawNode>(
    `SELECT id, surface_id, component_type, props, deleted_at FROM component_node WHERE id = ${id}`,
  );
  const row = rows[0];
  if (!row || !isOptionNone(row.deleted_at))
    fail("PANEL_UNAVAILABLE", "The component is unavailable or unreadable.");
  return row;
}
export async function getPagePanel(
  transport: StdbTransport,
  componentId: string,
) {
  const row = await rawNode(transport, componentId);
  if (row.component_type !== PAGE_PANEL_TYPE)
    fail("INVALID_PAGE_PANEL", "This component is not a versioned panel.");
  return {
    componentId,
    surfaceId: sqlId(row.surface_id),
    state: readPagePanel(row.props),
  };
}
export function pagePanelResult(panel: {
  componentId: string;
  surfaceId: string;
  state: PagePanel;
}) {
  return {
    ok: true,
    saved: true,
    component_id: panel.componentId,
    page_id: panel.surfaceId,
    revision: panel.state.revision,
    template_id: panel.state.templateId,
    template_version: panel.state.templateVersion,
    parameters: panel.state.parameters,
    editable_parameters: PAGE_PANEL_TEMPLATE.parameters,
    reference: {
      v: "pear_page_component_v1",
      surfaceId: panel.surfaceId,
      blockId: panel.componentId,
    },
  };
}
const idSchema = {
  type: "string",
  description: "Positive decimal component ID. Keep IDs as strings.",
};
const requestSchema = {
  type: "string",
  description:
    "Stable request ID. Retry uncertain writes with identical arguments and this same ID.",
};
// Convert the portable schema into the MCP SDK's JSON value representation.
const parametersSchema = {
  ...PAGE_PANEL_TEMPLATE.parameters,
  properties: JSON.parse(
    canonicalJson(PAGE_PANEL_TEMPLATE.parameters.properties ?? {}),
  ),
};
function tool(entry: McpToolEntry): McpToolEntry {
  return {
    ...entry,
    async execute(ctx, input) {
      try {
        return await entry.execute(ctx, input);
      } catch (error) {
        return JSON.stringify({
          ok: false,
          code:
            error instanceof PanelCommitError
              ? error.code
              : "INVALID_PAGE_PANEL",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
export const PAGE_PANEL_TOOLS: McpToolEntry[] = [
  tool({
    name: "list_page_panel_templates",
    description:
      "List pinned templates that can live on a Pear page. These are page-owned components, separate from retained assistant-message panels.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_ctx, input) {
      exact(input, []);
      return JSON.stringify({
        ok: true,
        templates: [
          {
            id: PAGE_PANEL_TEMPLATE.id,
            version: PAGE_PANEL_TEMPLATE.version,
            hash: PAGE_PANEL_TEMPLATE.hash,
            parameters: parametersSchema,
            defaults: PAGE_PANEL_DEFAULTS,
            allowed_edits: "parameters",
          },
        ],
      });
    },
  }),
  tool({
    name: "get_page_panel",
    description:
      "Read the saved state, revision and allowed settings of a page-owned panel. Unsent browser drafts are private and are not returned. Use get_page_components to discover a TrellisPanel component ID.",
    inputSchema: {
      type: "object",
      properties: { component_id: idSchema },
      required: ["component_id"],
      additionalProperties: false,
    },
    async execute(ctx, input) {
      exact(input, ["component_id"]);
      return JSON.stringify(
        pagePanelResult(
          await getPagePanel(ctx.transport, panelId(input.component_id)),
        ),
      );
    },
  }),
  tool({
    name: "create_page_panel",
    description:
      "Create one pinned note panel under an existing page container. Read get_page_components for the parent_id. The component belongs to its page and can be edited by humans and authorized agents. Reuse request_id and identical arguments after an uncertain result; creation is idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        parent_id: idSchema,
        template_id: { type: "string", enum: [PAGE_PANEL_TEMPLATE.id] },
        template_version: {
          type: "string",
          enum: [PAGE_PANEL_TEMPLATE.version],
        },
        parameters: {
          type: "object",
          properties: parametersSchema.properties,
          additionalProperties: false,
        },
        request_id: requestSchema,
      },
      required: [
        "parent_id",
        "template_id",
        "template_version",
        "parameters",
        "request_id",
      ],
      additionalProperties: false,
    },
    async execute(ctx, input) {
      exact(input, [
        "parent_id",
        "template_id",
        "template_version",
        "parameters",
        "request_id",
      ]);
      if (
        input.template_id !== PAGE_PANEL_TEMPLATE.id ||
        input.template_version !== PAGE_PANEL_TEMPLATE.version
      )
        fail("TEMPLATE_PINNED", "Choose an exact bundled page-panel template.");
      const parentId = panelId(input.parent_id),
        requestId = panelRequestId(input.request_id),
        parameters = panelChanges(input.parameters);
      const [parent, principal] = await Promise.all([
        rawNode(ctx.transport, parentId),
        caller(ctx),
      ]);
      const surfaceId = sqlId(parent.surface_id);
      const fingerprint = await sha256({ operation: "create", parameters });
      let acknowledgement: unknown;
      try {
        await ctx.transport.call("create_trellis_panel", [
          parentId,
          requestId,
          canonicalJson(parameters),
        ]);
      } catch (error) {
        const message = reducerErrorMessage(error);
        const code =
          /\b(REQUEST_REUSED|PANEL_DELETED|INVALID_PAGE_PANEL):/.exec(
            message,
          )?.[1];
        if (code) fail(code, message);
        if (
          /lacks .*access|Authentication required|not found|cannot contain/i.test(
            message,
          )
        )
          fail("AUTHORIZATION_DENIED", message);
        acknowledgement = error;
      }
      const deadline = Date.now() + 3000;
      do {
        try {
          const rows = await ctx.transport.sql<RawNode>(
            `SELECT id, surface_id, component_type, props, deleted_at FROM component_node WHERE surface_id = ${surfaceId}`,
          );
          for (const row of rows) {
            if (
              row.component_type !== PAGE_PANEL_TYPE ||
              !isOptionNone(row.deleted_at)
            )
              continue;
            let saved: PagePanel;
            try {
              saved = readPagePanel(row.props);
            } catch {
              continue;
            }
            if (
              saved.creation.parentId !== parentId ||
              saved.creation.principal !== principal ||
              saved.creation.requestId !== requestId
            )
              continue;
            if (saved.creation.fingerprint !== fingerprint)
              fail(
                "REQUEST_REUSED",
                "This create request has different arguments.",
              );
            return JSON.stringify(
              pagePanelResult({
                componentId: sqlId(row.id),
                surfaceId,
                state: saved,
              }),
            );
          }
        } catch (error) {
          if (error instanceof PanelCommitError) throw error;
          acknowledgement ??= error;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      fail(
        "COMMIT_UNCONFIRMED",
        `The created panel was not observed. Retry the identical request.${acknowledgement ? " " + reducerErrorMessage(acknowledgement) : ""}`,
      );
    },
  }),
  tool({
    name: "update_page_panel",
    description:
      "Update declared settings on the SAME page component. Read get_page_panel first and pass its revision as base_revision. Human edits use the same commit path. Dirty browser input survives unrelated changes. Template identity and actions stay fixed. A stale revision requires a new read and deliberate proposal; an uncertain result requires an identical retry.",
    inputSchema: {
      type: "object",
      properties: {
        component_id: idSchema,
        base_revision: { type: "integer", minimum: 0 },
        request_id: requestSchema,
        parameters: {
          type: "object",
          properties: parametersSchema.properties,
          additionalProperties: false,
        },
      },
      required: ["component_id", "base_revision", "request_id", "parameters"],
      additionalProperties: false,
    },
    async execute(ctx, input) {
      exact(input, [
        "component_id",
        "base_revision",
        "request_id",
        "parameters",
      ]);
      const componentId = panelId(input.component_id),
        requestId = panelRequestId(input.request_id),
        parameters = panelChanges(input.parameters);
      if (
        !Number.isSafeInteger(input.base_revision) ||
        (input.base_revision as number) < 0
      )
        fail("INVALID_INPUT", "Expected a safe base revision.");
      const principal = await caller(ctx);
      const current = await getPagePanel(ctx.transport, componentId);
      const state = await commitObservedPagePanel(
        {
          componentId,
          baseRevision: input.base_revision as number,
          requestId,
          parameters,
        },
        {
          principal,
          commit: (args) =>
            ctx.transport.call("commit_trellis_panel", [
              args.componentId,
              args.baseRevision,
              args.requestId,
              canonicalJson(args.parameters),
            ]),
          read: async () =>
            (await getPagePanel(ctx.transport, componentId)).state,
        },
      );
      const receipt = state.receipts.find(
        (item) => item.principal === principal && item.requestId === requestId,
      )!;
      return JSON.stringify({
        ...pagePanelResult({ ...current, state }),
        committed_revision: receipt.revision,
        replayed: current.state.receipts.some(
          (item) =>
            item.principal === principal && item.requestId === requestId,
        ),
      });
    },
  }),
];
