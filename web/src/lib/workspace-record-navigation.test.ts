// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connectionIdentity, createAuthoredComponent, type AuthoredComponent, type ComponentDataAdapter, type ComponentSource } from "@eclosion-tech/trellis";
import type { BlockRendererProps } from "@eclosion-tech/pulp";
import { INTERFACE_REGISTRY } from "@pear/trellis-ui";
import { useOpenWorkspaceRecord } from "../hooks/useOpenWorkspaceRecord";
import { workspaceComponentQuery, workspaceComponentRead, type WorkspaceComponentData } from "./component-workspace-data";
import { AuthoredPageComponentRenderer } from "../components/component-renderers/AuthoredPageComponent";

const mocks = vi.hoisted(() => ({ push: vi.fn(), slug: "acme" as string | undefined, row: null as any, adapter: {} as any }));
vi.mock("next/navigation", () => ({ useParams: () => ({ slug: mocks.slug }), useRouter: () => ({ push: mocks.push }) }));
vi.mock("spacetimedb/react", () => ({ useSpacetimeDB: () => ({ getConnection: () => ({ db: { component_node: { id: { find: () => mocks.row } } } }) }) }));
vi.mock("../hooks/usePageAccess", () => ({ usePageAccess: () => ({ principal: "human", canEdit: false }) }));
vi.mock("../hooks/useComponentData", () => ({ useComponentData: () => ({ dataAdapters: { "pear.database": mocks.adapter } }) }));
vi.mock("../components/component-renderers/ComponentTemplateLibrary", () => ({ SaveComponentTemplate: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const source: ComponentSource = {
  label: "Asks", mode: "query", fields: { title: { type: "string" }, raised: { type: "date" } },
  connection: { adapter: "pear.database", schemaId: "5", mapping: { title: "$title", raised: "9" } },
};
let root: Root;
let container: HTMLDivElement;
let saved: AuthoredComponent;
const data = () => ({
  ready: true, principal: "human", privileged: false,
  pages: [{ id: 10n }, { id: 11n, parentId: 10n, title: "Product ask" }, { id: 12n, parentId: 20n }],
  schemas: [{ id: 5n, pageId: 10n }], rules: [],
  properties: [{ id: 9n, schemaId: 5n, propertyType: { tag: "Date" } }],
  values: [{ pageId: 11n, propertyDefinitionId: 9n, value: { tag: "Date", value: BigInt(Date.now()) } }],
}) as unknown as WorkspaceComponentData;
const ref = async () => ({ workspace: "acme", surfaceId: saved.document.documentId, source: "asks", recordId: "11", connectionIdentity: await connectionIdentity(source.connection!) });
beforeEach(async () => {
  mocks.push.mockReset(); mocks.slug = "acme";
  window.history.replaceState({ dashboard: true }, "", "/workspace/acme/7?view=product#asks");
  saved = { ...await createAuthoredComponent("Product work", {
    catalog: INTERFACE_REGISTRY.catalog, principal: "human", parentId: "7", requestId: "create",
    documentId: "pear-page:7:component:8", instanceId: "8",
  }), sources: { asks: source } };
  saved = JSON.parse(JSON.stringify(saved));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); });
async function eventually(check: () => void) {
  for (let i = 0; i < 100; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    try { check(); return; } catch (error) { if (i === 99) throw error; }
  }
}

it.each(["RecordList", "DataTable", "CalendarGrid"])("opens an existing %s row via Pear navigation without a detail-panel history entry", async type => {
  const workspace = data();
  mocks.adapter = { query: async (s: ComponentSource, q: any) => workspaceComponentQuery(s, q, workspace), read: vi.fn(async (s, id) => workspaceComponentRead(s, id, workspace)) };
  saved.actions = { open: { kind: "open", source: "asks", recordId: { row: true }, input: { type: "object", properties: {} }, message: "Open ask" } };
  saved.document.nodes.push({ id: "records", parentId: saved.document.rootId, order: 0, type,
    props: { source: "asks", rowAction: "open", ...(type === "DataTable" ? { columns: ["title"] } : { titleField: "title" }), ...(type === "CalendarGrid" ? { startField: "raised" } : {}) } });
  const stored = JSON.stringify(saved);
  mocks.row = { id: 8n, surfaceId: 7n, componentType: "TrellisPanel", props: stored };
  const pushState = vi.spyOn(window.history, "pushState");
  await act(async () => root.render(createElement(AuthoredPageComponentRenderer, { node: mocks.row } as BlockRendererProps)));
  const selector = type === "DataTable" ? ".trellis-data-table tbody button" : type === "RecordList" ? ".trellis-record-list button" : ".trellis-calendar-items button";
  let button: HTMLButtonElement;
  await eventually(() => {
    button = container.querySelector<HTMLButtonElement>(selector)!;
    expect(button).not.toBeNull(); expect(button.disabled).toBe(false);
  });
  await act(async () => button!.click());
  await eventually(() => expect(mocks.push).toHaveBeenCalledWith("/workspace/acme/11"));
  expect(mocks.push).toHaveBeenCalledTimes(1);
  expect(mocks.adapter.read).toHaveBeenCalled();
  expect(pushState).not.toHaveBeenCalled();
  expect(window.history.state).toEqual({ dashboard: true });
  expect(window.location.pathname + window.location.search + window.location.hash).toBe("/workspace/acme/7?view=product#asks");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.row.props).toBe(stored);
});

async function harness(adapter: ComponentDataAdapter = { read: async (s, id) => workspaceComponentRead(s, id, data()) }) {
  const options = { workspace: mocks.slug, surfaceId: saved.document.documentId, principal: "human", sources: saved.sources,
    read: () => saved, adapter, openPanel: vi.fn() };
  let state!: ReturnType<typeof useOpenWorkspaceRecord>;
  function Host() { state = useOpenWorkspaceRecord(options); return createElement("p", null, state.message); }
  const render = async () => { await act(async () => root.render(createElement(Host))); };
  await render();
  return { options, render,
    start: async () => { const target = await ref(); let opening!: Promise<void>; await act(async () => { opening = state.onOpenRecord(target); }); return { opening }; },
    open: async (r?: Awaited<ReturnType<typeof ref>>) => { const target = r ?? await ref(); await act(async () => { await state.onOpenRecord(target); }); } };
}

it.each(["missing", "deleted", "wrong database", "denied database", "denied record", "anonymous"])("keeps the dashboard and conceals details for a %s record", async failure => {
  const workspace = data();
  if (failure === "missing") workspace.pages = [];
  if (failure === "deleted") (workspace.pages[1] as any).deletedAt = {};
  if (failure === "wrong database") workspace.pages[1].parentId = 20n;
  if (failure.startsWith("denied")) workspace.rules = [{ pageId: failure === "denied database" ? 10n : 11n, principal: { tag: "WorkspaceMember", value: { toHexString: () => "other" } }, permission: { tag: "Read" } }] as any;
  if (failure === "anonymous") workspace.principal = "anonymous";
  const host = await harness({ read: async (s, id) => workspaceComponentRead(s, id, workspace) });
  await host.open();
  expect(mocks.push).not.toHaveBeenCalled(); expect(host.options.openPanel).not.toHaveBeenCalled();
  expect(container.textContent).toMatch(/unavailable|cannot read/);
});

it("rejects mismatched ownership, source identity, unknown sources and invalid page IDs", async () => {
  const read = vi.fn(); const host = await harness({ read }); const valid = await ref();
  for (const patch of [{ workspace: "other" }, { surfaceId: "other" }, { source: "__proto__" }, { connectionIdentity: "old" }, { recordId: "https://example.com" }]) await host.open({ ...valid, ...patch });
  expect(read).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
});

it.each(["reconnect", "delete component", "principal", "workspace", "unmount", "navigate away"])("cancels pending navigation after %s", async change => {
  let finish!: (value: any) => void;
  const read = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const host = await harness({ read });
  const { opening } = await host.start();
  await eventually(() => expect(read).toHaveBeenCalledTimes(1));
  if (change === "reconnect") saved = { ...saved, sources: { asks: { ...source, connection: { adapter: "pear.database", schemaId: "6", mapping: { title: "$title", raised: "9" } } } } };
  if (change === "delete component") host.options.read = () => { throw new Error("deleted"); };
  if (change === "principal") { host.options.principal = "other"; await host.render(); }
  if (change === "workspace") { host.options.workspace = "elsewhere"; await host.render(); }
  if (change === "unmount") await act(async () => root.render(null));
  if (change === "navigate away") window.history.replaceState(null, "", "/workspace/acme/99");
  await act(async () => { finish({ status: "ready", record: { id: "11", values: {} } }); await opening; });
  expect(mocks.push).not.toHaveBeenCalled();
});

it("uses the standalone page route when no workspace slug exists", async () => {
  mocks.slug = undefined; const host = await harness();
  await host.open({ ...await ref(), workspace: "" });
  expect(mocks.push).toHaveBeenCalledWith("/workspace/11");
});

it("keeps non-Pear sources on the generic record panel", async () => {
  const external = { ...source, connection: { adapter: "external.json" as const, readUrl: "https://example.com/records", recordsPath: "records", idField: "id", mapping: { title: "name", raised: "date" } } };
  saved.sources = { asks: external };
  const read = vi.fn(); const host = await harness({ read });
  const record = { ...await ref(), recordId: "external-id", connectionIdentity: await connectionIdentity(external.connection) };
  await host.open(record);
  expect(host.options.openPanel).toHaveBeenCalledWith(record); expect(read).not.toHaveBeenCalled(); expect(mocks.push).not.toHaveBeenCalled();
});


it("leaves one router entry so Back restores the dashboard URL/state and Forward opens the page", async () => {
  const dashboard = window.location.href;
  const length = window.history.length;
  const read = vi.fn(async (s, id) => workspaceComponentRead(s, id, data()));
  // Model Next's navigation entry; the host must never insert a panel entry first.
  mocks.push.mockImplementation(href => window.history.pushState({ __NA: true }, "", href));
  const host = await harness({ read });
  await host.open();
  expect(window.location.pathname).toBe("/workspace/acme/11");
  expect(window.history.length).toBe(length + 1);
  const traverse = async (direction: "back" | "forward") => {
    await act(async () => {
      const popped = new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true }));
      window.history[direction](); await popped;
    });
  };
  await traverse("back");
  expect(window.location.href).toBe(dashboard);
  expect(window.history.state).toEqual({ dashboard: true });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await traverse("forward");
  expect(window.location.pathname).toBe("/workspace/acme/11");
  expect(read).toHaveBeenCalledTimes(1);
  expect(mocks.push).toHaveBeenCalledTimes(1);
});

it("opens readable records without requiring write access", async () => {
  const workspace = data();
  workspace.rules = [{ pageId: 10n, principal: { tag: "WorkspaceMember", value: { toHexString: () => "human" } }, permission: { tag: "Read" } }] as any;
  const host = await harness({ read: async (s, id) => workspaceComponentRead(s, id, workspace) });
  await host.open();
  expect(mocks.push).toHaveBeenCalledWith("/workspace/acme/11");
});

it("only opens the latest request when reads finish out of order", async () => {
  let finish!: (value: any) => void;
  const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce({ status: "ready", record: { id: "13", values: {} } });
  const host = await harness({ read });
  const { opening } = await host.start();
  await eventually(() => expect(read).toHaveBeenCalledTimes(1));
  await host.open({ ...await ref(), recordId: "13" });
  await act(async () => { finish({ status: "ready", record: { id: "11", values: {} } }); await opening; });
  expect(mocks.push).toHaveBeenCalledTimes(1);
  expect(mocks.push).toHaveBeenCalledWith("/workspace/acme/13");
});

it("does not navigate when a read returns a different record or throws", async () => {
  const read = vi.fn().mockResolvedValueOnce({ status: "ready", record: { id: "99", values: {} } }).mockRejectedValueOnce(new Error("offline"));
  const host = await harness({ read });
  await host.open(); await host.open();
  expect(mocks.push).not.toHaveBeenCalled();
  expect(container.textContent).toBe("This record is unavailable.");
});
