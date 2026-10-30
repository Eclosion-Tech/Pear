import { describe, it, expect } from "vitest";
import { canonicalJson, createRetainedInterface, commitRetainedInterface, type RetainedInterface } from "@eclosion-tech/trellis";
import { INTERFACE_REGISTRY } from "@pear/trellis-ui";
import { PAGE_PANEL_TOOLS } from "./page-panels";
import type { McpContext } from "./types";
const principal = "a".repeat(64);
async function fixture() {
  let saved: RetainedInterface | null = null, calls = 0, denied = false, loseResponse = false;
  const row = () => ({ id: "100", surface_id: "7", component_type: "TrellisPanel", props: canonicalJson(saved), deleted_at: null });
  const ctx = { aiUserId: 1n, transport: {
    sql: async (query: string) => query.includes("ai_user_config") ? [{ identity: principal }] : query.includes("WHERE id = 70") ? [{ id: "70", surface_id: "7", component_type: "Container", props: "{}", deleted_at: null }] : saved ? [row()] : [],
    call: async (name: string, args: unknown[]) => {
      calls++;
      if (denied) throw new Error("Caller lacks write access on this page");
      if (name === "create_trellis_panel") saved = await createRetainedInterface(JSON.parse(args[2] as string), { registry: INTERFACE_REGISTRY, principal, parentId: "70", requestId: args[1] as string, documentId: "pear-page:7:component:100", instanceId: "pear-component:100" });
      else saved = await commitRetainedInterface(saved!, { baseRevision: args[1] as number, requestId: args[2] as string, command: JSON.parse(args[3] as string) }, { registry: INTERFACE_REGISTRY, principal });
      if (loseResponse) throw new Error("Connection closed after commit");
    },
  } } as unknown as McpContext;
  return { run: async (name: string, input: Record<string, unknown>) => JSON.parse(await PAGE_PANEL_TOOLS.find(tool => tool.name === name)!.execute(ctx, input)), saved: () => saved!, calls: () => calls, deny: () => { denied = true; }, lose: () => { loseResponse = true; },
    humanToggle: async (key: string) => {
      const document = saved!.document, node = document.nodes.find(node => node.key === key)!;
      saved = await commitRetainedInterface(saved!, { baseRevision: document.revision, requestId: `human:${key}`, command: { kind: "action", event: { documentId: document.documentId, revision: document.revision, nodeId: node.id, slot: "checklist.toggle", invocationId: `human:${key}`, input: {} } } }, { registry: INTERFACE_REGISTRY, principal: "human" });
    },
  };
}
const create = { parent_id: "70", template_id: "trellis.checklist", template_version: "1.0.0", request_id: "create", parameters: { headingLevel: 3, firstDone: true } };
describe("registered page interfaces through the existing tools", () => {
  it("discovers typed definitions, creates and reads their saved capability contract", async () => {
    const host = await fixture();
    expect((await host.run("list_page_panel_templates", {})).templates.map((entry: any) => entry.id)).toEqual(["pear.note-panel", "trellis.note-form", "trellis.checklist"]);
    const created = await host.run("create_page_panel", create);
    expect(created.ok).toBe(true); expect(created.document.template.parameters.firstDone).toBe(true);
    expect(created.actions).toEqual({ "checklist.toggle": { input: { type: "object", properties: {} } } });
    expect(created.reference).toEqual({ v: "pear_page_component_v1", surfaceId: "7", blockId: "100" });
    expect((await host.run("get_page_panel", { component_id: "100" })).document).toEqual(created.document);
  });
  it("uses the same path for typed settings and structural patches, including lost acknowledgements", async () => {
    const host = await fixture(); await host.run("create_page_panel", create);
    host.lose();
    const settings = await host.run("update_page_panel", { component_id: "100", base_revision: 0, request_id: "settings", parameters: { title: "Updated" } });
    expect(settings.revision).toBe(1);
    const command = { component_id: "100", base_revision: 1, request_id: "structure", operations: [{ op: "setText", target: { key: "first-task" }, text: [{ text: "Revised task" }] }] };
    const changed = await host.run("update_page_panel", command);
    expect(changed.revision).toBe(2); expect(changed.allowed_edits).toEqual(["patch"]);
    expect((await host.run("update_page_panel", command)).replayed).toBe(true);
    expect((await host.run("update_page_panel", { component_id: "100", base_revision: 2, request_id: "forked", parameters: {} })).code).toBe("TEMPLATE_FORKED");
    host.deny();
    expect((await host.run("update_page_panel", command)).code).toBe("AUTHORIZATION_DENIED");
  });
  it("rejects schema violations, ambiguous edits, stale revisions and other definitions' actions before writing", async () => {
    const host = await fixture();
    expect((await host.run("create_page_panel", { ...create, parameters: { firstDone: "true" } })).ok).toBe(false);
    expect(host.calls()).toBe(0);
    await host.run("create_page_panel", create);
    const input = { component_id: "100", base_revision: 0, request_id: "edit" };
    expect((await host.run("update_page_panel", { ...input, parameters: {}, operations: [] })).code).toBe("INVALID_INPUT");
    expect((await host.run("update_page_panel", { ...input, base_revision: 7, parameters: {} })).code).toBe("STALE_REVISION");
    expect((await host.run("update_page_panel", { ...input, operations: [{ op: "insertNode", node: { id: "forged", parentId: host.saved().document.rootId, type: "Button", order: 3, props: {}, action: { slot: "notes.save", input: { value: "forged" } } } }] })).code).toBe("UNKNOWN_ACTION");
    expect(host.calls()).toBe(1); expect(host.saved().document.revision).toBe(0);
  });
  it("discovers and performs the hosted add-third-task/reorder request after human actions fork the template", async () => {
    const host = await fixture(); await host.run("create_page_panel", { ...create, parameters: {} });
    await host.humanToggle("first-task"); await host.humanToggle("second-task");
    const current = await host.run("get_page_panel", { component_id: "100" });
    expect(current.revision).toBe(2); expect(current.allowed_edits).toEqual(["patch"]); expect(current.editable_parameters).toBeNull();
    expect(current.patch_contract.protocol).toBe("trellis_patch_v1");
    const advertised = PAGE_PANEL_TOOLS.find(tool => tool.name === "update_page_panel")!.inputSchema.properties!.operations as any;
    expect(advertised.items.oneOf.map((schema: any) => schema.properties.op.enum[0])).toEqual(["insertNode", "removeSubtree", "moveNode", "setText", "setProps"]);
    const insert = structuredClone(current.patch_contract.examples.insertNode);
    insert.node.text = [{ text: "Ship a test" }]; insert.node.props.checked = false; insert.node.order = 1;
    const moves = ["first-task", "second-task", "scratch"].map((key, index) => ({
      ...structuredClone(current.patch_contract.examples.moveNode), target: { id: current.document.nodes.find((node: any) => node.key === key).id }, order: index + 2,
    }));
    const request = { component_id: "100", base_revision: current.revision, request_id: "ship-a-test", operations: [insert, ...moves] };
    const result = await host.run("update_page_panel", request);
    expect(result.ok).toBe(true); expect(result.revision).toBe(3);
    expect(result.document.nodes.filter((node: any) => node.parentId === result.document.rootId).sort((a: any,b: any) => a.order-b.order).map((node: any) => node.text?.[0]?.text ?? node.key)).toEqual(["Tasks", "Ship a test", "First task", "Second task", "scratch"]);
    for (const key of ["first-task", "second-task", "scratch"]) {
      const before = current.document.nodes.find((node: any) => node.key === key), after = result.document.nodes.find((node: any) => node.key === key);
      expect(after.id).toBe(before.id); expect(after.props).toEqual(before.props); expect(after.text).toEqual(before.text);
    }
    expect(result.document.nodes.find((node: any) => node.id === insert.node.id).action.slot).toBe("checklist.toggle");
    expect((await host.run("update_page_panel", request)).replayed).toBe(true);
  });
  it("returns the exact bad operation path and a discovery hint without writing or changing the saved revision", async () => {
    const host = await fixture(); const current = await host.run("create_page_panel", create);
    const before = canonicalJson(host.saved()), insert = current.patch_contract.examples.insertNode;
    const request = { component_id: "100", base_revision: 0, request_id: "bad-shape" };
    const wrapped = await host.run("update_page_panel", { ...request, operations: [{ insertNode: { node: insert.node } }] });
    expect(wrapped.code).toBe("INVALID_OPERATION"); expect(wrapped.path).toBe("$.operations[0]"); expect(wrapped.hint).toContain("patch_contract");
    const misplaced = await host.run("update_page_panel", { ...request, operations: [{ ...insert, parentId: current.document.rootId }] });
    expect(misplaced.code).toBe("UNKNOWN_KEY"); expect(misplaced.path).toBe("$.operations[0].parentId");
    expect(host.calls()).toBe(1); expect(canonicalJson(host.saved())).toBe(before);
  });
});
