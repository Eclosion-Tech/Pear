// @vitest-environment happy-dom
import { act, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ComponentSource } from "@eclosion-tech/trellis";

const state = vi.hoisted(() => ({
  access: { principal: "first", ready: true, canEdit: true, privileged: false, pages: [{ id: 10n }, { id: 11n, parentId: 10n }] },
  tables: {
    database_schema: { ready: true, rows: [{ id: 5n, pageId: 10n }] },
    property_definition: { ready: true, rows: [{ id: 7n, schemaId: 5n, propertyType: { tag: "Text" } }] },
    page_property_value: { ready: true, rows: [{ pageId: 11n, propertyDefinitionId: 7n, value: { tag: "Text", value: "Task" } }] },
    page_access_rule: { ready: true, rows: [] },
  },
}));
vi.mock("../hooks/usePageAccess", () => ({ usePageAccess: () => ({ ...state.access, rules: state.tables.page_access_rule.rows }) }));
vi.mock("../hooks/useScopedTable", () => ({ useScopedTable: (_table: unknown, query: string) => state.tables[query.replace("SELECT * FROM ", "") as keyof typeof state.tables] }));
import { useComponentData } from "../hooks/useComponentData";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const source: ComponentSource = { label: "Tasks", mode: "query", fields: { name: { type: "string" } }, connection: { adapter: "pear.database", schemaId: "5", mapping: { name: "7" } } };
async function mount() {
  state.access.principal = "first";
  state.access.privileged = false;
  let current!: ReturnType<typeof useComponentData>;
  function Host() {
    current = useComponentData(10n, async () => { throw new Error("No commits"); }, () => { throw new Error("No component reads"); });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Host)));
  return {
    adapter: current.dataAdapters["pear.database"],
    render: () => flushSync(() => root.render(createElement(Host))),
    close: () => act(async () => root.unmount()),
  };
}

it.each(["pages", "principal", "privileged", "rules"] as const)("drops query/read results captured before a %s change", async (dependency) => {
  const host = await mount(), signal = new AbortController().signal;
  try {
    expect((await host.adapter.query!(source, { fields: ["name"] }, { signal })).status).toBe("ready");
    let query!: ReturnType<NonNullable<typeof host.adapter.query>>;
    let read!: ReturnType<NonNullable<typeof host.adapter.read>>;
    await act(async () => {
      query = host.adapter.query!(source, { fields: ["name"] }, { signal });
      read = host.adapter.read!(source, "11", { signal });
      if (dependency === "pages") state.access.pages = [...state.access.pages];
      if (dependency === "principal") state.access.principal = "second";
      if (dependency === "privileged") state.access.privileged = true;
      if (dependency === "rules") state.tables.page_access_rule.rows = [];
      host.render();
    });
    expect(await query).toMatchObject({ status: "unavailable", records: [], message: "This result is out of date." });
    expect(await read).toEqual({ status: "unavailable", message: "This result is out of date." });
    if (dependency === "principal") {
      expect((await host.adapter.query!(source, { fields: ["name"] }, { signal })).status).toBe("unavailable");
      expect((await host.adapter.read!(source, "11", { signal })).status).toBe("unavailable");
    }
  } finally { await host.close(); }
});

it("watch follows snapshot dependencies and stops on abort or unsubscribe", async () => {
  const host = await mount(), controller = new AbortController(), changed = vi.fn(), snapshots = vi.fn();
  const unwatch = host.adapter.watch!(source, changed, controller.signal);
  const unsubscribe = host.adapter.subscribe!(source, snapshots, controller.signal);
  try {
    expect(changed).not.toHaveBeenCalled();
    for (const table of Object.values(state.tables)) {
      await act(async () => { table.rows = [...table.rows] as typeof table.rows; host.render(); });
    }
    expect(changed).toHaveBeenCalledTimes(4);
    expect(snapshots).toHaveBeenCalledTimes(5);
    await act(async () => host.render());
    expect(changed).toHaveBeenCalledTimes(4);
    controller.abort();
    await act(async () => { state.access.pages = [...state.access.pages]; host.render(); });
    expect(changed).toHaveBeenCalledTimes(4);
    expect(snapshots).toHaveBeenCalledTimes(5);
    unwatch(); unsubscribe();
    const stop = host.adapter.watch!(source, changed, new AbortController().signal);
    stop();
    host.adapter.watch!(source, changed, controller.signal);
    await act(async () => { state.access.pages = [...state.access.pages]; host.render(); });
    expect(changed).toHaveBeenCalledTimes(4);
    expect((await host.adapter.query!(source, { fields: ["name"] }, { signal: controller.signal })).status).toBe("unavailable");
  } finally { unwatch(); unsubscribe(); await host.close(); }
});
