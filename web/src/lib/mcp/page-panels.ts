import { canonicalJson, sha256, TrellisError, createRetainedInterface, interfaceCreationFingerprint, commitRetainedInterface, observeInterfaceCommit, interfaceDefinition, type RetainedInterface, type InterfaceCreate, type InterfaceCommand, type JsonObject } from "@eclosion-tech/trellis";
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
  INTERFACE_REGISTRY,
  isRetainedPageInterface,
  readPageInterface,
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
    state: isRetainedPageInterface(row.props) ? readPageInterface(row.props, sqlId(row.surface_id), componentId) : readPagePanel(row.props),
  };
}
export function pagePanelResult(panel: {
  componentId: string;
  surfaceId: string;
  state: PagePanel | RetainedInterface;
}) {
  if ("document" in panel.state) {
    const saved = panel.state, origin = saved.document.template!, entry = interfaceDefinition(INTERFACE_REGISTRY, origin.id, origin.version);
    return {
      ok: true, saved: true, component_id: panel.componentId, page_id: panel.surfaceId, revision: saved.document.revision,
      template_id: origin.id, template_version: origin.version, parameters: origin.parameters,
      editable_parameters: entry.template.parameters, allowed_edits: origin.state === "linked" ? ["parameters", "patch"] : ["patch"],
      document: saved.document, components: INTERFACE_REGISTRY.catalog.components,
      actions: Object.fromEntries(Object.values(entry.bindings).map(binding => [binding.action, { input: binding.input }])),
      reference: { v: "pear_page_component_v1", surfaceId: panel.surfaceId, blockId: panel.componentId },
    };
  }
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
            error instanceof PanelCommitError || error instanceof TrellisError
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
          ...INTERFACE_REGISTRY.definitions.map(entry => ({ id: entry.template.id, version: entry.template.version, hash: entry.template.hash, parameters: entry.template.parameters, defaults: entry.defaults, allowed_edits: ["parameters", "patch"] })),
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
      "Create a registered interface under an existing page container. Discover the exact template and typed parameter schema with list_page_panel_templates. Read get_page_components for parent_id. Humans and agents share the saved component and its revision. Reuse request_id and identical arguments after an uncertain result.",
    inputSchema: {
      type: "object",
      properties: {
        parent_id: idSchema,
        template_id: { type: "string", enum: [PAGE_PANEL_TEMPLATE.id, ...INTERFACE_REGISTRY.definitions.map(entry => entry.template.id)] },
        template_version: {
          type: "string",
          enum: [...new Set([PAGE_PANEL_TEMPLATE.version, ...INTERFACE_REGISTRY.definitions.map(entry => entry.template.version)])],
        },
        parameters: {
          type: "object",
          description: "Parameters matching the selected template's schema from list_page_panel_templates.",
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
      const generic = input.template_id !== PAGE_PANEL_TEMPLATE.id;
      if (generic) interfaceDefinition(INTERFACE_REGISTRY, String(input.template_id), String(input.template_version));
      else if (input.template_version !== PAGE_PANEL_TEMPLATE.version) fail("TEMPLATE_PINNED", "Choose an exact bundled page-panel template.");
      const parentId = panelId(input.parent_id),
        requestId = panelRequestId(input.request_id),
        parameters = generic ? input.parameters as JsonObject : panelChanges(input.parameters);
      const [parent, principal] = await Promise.all([
        rawNode(ctx.transport, parentId),
        caller(ctx),
      ]);
      const surfaceId = sqlId(parent.surface_id);
      const descriptor: InterfaceCreate = { templateId: String(input.template_id), templateVersion: String(input.template_version), parameters };
      if (generic) await createRetainedInterface(descriptor, { registry: INTERFACE_REGISTRY, principal, parentId, requestId, documentId: "validation", instanceId: "validation" });
      const fingerprint = generic ? await interfaceCreationFingerprint(descriptor) : await sha256({ operation: "create", parameters });
      let acknowledgement: unknown;
      try {
        await ctx.transport.call("create_trellis_panel", [
          parentId,
          requestId,
          canonicalJson(generic ? descriptor : parameters),
        ]);
      } catch (error) {
        const message = reducerErrorMessage(error);
        const code =
          /\b(REQUEST_REUSED|PANEL_DELETED|INVALID_PAGE_PANEL|INVALID_INTERFACE|TEMPLATE_NOT_FOUND):/.exec(
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
            let saved: PagePanel | RetainedInterface;
            try {
              saved = isRetainedPageInterface(row.props) ? readPageInterface(row.props, surfaceId, sqlId(row.id)) : readPagePanel(row.props);
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
      "Edit the SAME saved page interface. Read get_page_panel first for revision, typed parameters, document and allowed capabilities. Supply either parameters (while linked) or operations (insertNode, removeSubtree, moveNode, setText, setProps). Structural edits fork the pinned template; use operations for later edits. Preserve existing node IDs to retain private input. Human edits share this revision and commit path. A stale revision requires a new read and deliberate proposal; an uncertain result requires an identical retry.",
    inputSchema: {
      type: "object",
      properties: {
        component_id: idSchema,
        base_revision: { type: "integer", minimum: 0 },
        request_id: requestSchema,
        parameters: {
          type: "object",
          description: "Typed parameter changes allowed by the selected interface definition.",
        },
        operations: { type: "array", minItems: 1, maxItems: 100, items: { type: "object" }, description: "Atomic Trellis patch operations. Use the document, catalog and actions from get_page_panel. Host bindings and template provenance remain pinned." },
      },
      required: ["component_id", "base_revision", "request_id"],
      additionalProperties: false,
    },
    async execute(ctx, input) {
      exact(input, [
        "component_id",
        "base_revision",
        "request_id",
        "parameters",
        "operations",
      ]);
      if (Object.hasOwn(input, "parameters") === Object.hasOwn(input, "operations")) fail("INVALID_INPUT", "Supply either parameters or operations.");
      const componentId = panelId(input.component_id),
        requestId = panelRequestId(input.request_id);
      if (
        !Number.isSafeInteger(input.base_revision) ||
        (input.base_revision as number) < 0
      )
        fail("INVALID_INPUT", "Expected a safe base revision.");
      const principal = await caller(ctx);
      const current = await getPagePanel(ctx.transport, componentId);
      if ("document" in current.state) {
        const command = (Object.hasOwn(input, "parameters") ? { kind: "parameters", parameters: input.parameters } : { kind: "patch", operations: input.operations }) as InterfaceCommand;
        const request = { baseRevision: input.base_revision as number, requestId, command };
        await commitRetainedInterface(current.state, request, { registry: INTERFACE_REGISTRY, principal });
        const state = await observeInterfaceCommit(request, {
          registry: INTERFACE_REGISTRY, principal,
          write: async args => {
            try { return await ctx.transport.call("commit_trellis_panel", [componentId, args.baseRevision, args.requestId, canonicalJson(args.command)]); }
            catch (error) {
              const message = reducerErrorMessage(error);
              if (/lacks .*access|Authentication required|not found/i.test(message)) fail("AUTHORIZATION_DENIED", message);
              const code = /\b(STALE_REVISION|STALE_ACTION|REQUEST_REUSED|INVALID_INTERFACE|TEMPLATE_FORKED|TEMPLATE_PINNED|UNKNOWN_ACTION|UNKNOWN_NODE|DUPLICATE_ID):/.exec(message)?.[1];
              if (code) fail(code, message);
              throw error;
            }
          },
          read: async () => {
            const observed = (await getPagePanel(ctx.transport, componentId)).state;
            if (!("document" in observed)) fail("INVALID_INTERFACE", "The saved interface changed format.");
            return observed;
          },
        });
        const receipt = state.receipts.find(item => item.principal === principal && item.requestId === requestId)!;
        return JSON.stringify({ ...pagePanelResult({ ...current, state }), committed_revision: receipt.revision, replayed: current.state.receipts.some(item => item.principal === principal && item.requestId === requestId) });
      }
      if (Object.hasOwn(input, "operations")) fail("UNSUPPORTED_OPERATION", "This legacy Note panel supports parameter changes. Create a registered interface for structural edits.");
      const parameters = panelChanges(input.parameters);
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
          read: async () => {
            const observed = (await getPagePanel(ctx.transport, componentId)).state;
            if ("document" in observed) fail("INVALID_PAGE_PANEL", "The saved panel changed format.");
            return observed;
          },
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
