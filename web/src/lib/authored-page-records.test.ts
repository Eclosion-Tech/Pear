// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createAuthoredComponent, type AuthoredComponent, type ComponentSource } from "@eclosion-tech/trellis";
import type { AuthoredComponentViewProps } from "@eclosion-tech/trellis-react";
import type { BlockRendererProps } from "@eclosion-tech/pulp";
import { INTERFACE_REGISTRY } from "@pear/trellis-ui";
import { createHostSourceRegistry, HostSourceRegistry } from "./repeater/hostSources";

const mocks = vi.hoisted(() => ({
  adapter: { query: vi.fn(), watch: vi.fn(), subscribe: vi.fn() },
  view: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ slug: ["acme"] }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("spacetimedb/react", () => ({ useSpacetimeDB: () => ({ getConnection: () => null }) }));
vi.mock("../hooks/usePageAccess", () => ({ usePageAccess: () => ({ principal: "human", canEdit: true }) }));
vi.mock("../hooks/useComponentData", () => ({ useComponentData: () => ({ dataAdapters: { "pear.database": mocks.adapter } }) }));
vi.mock("../components/component-renderers/ComponentTemplateLibrary", () => ({ SaveComponentTemplate: () => null }));
vi.mock("@eclosion-tech/trellis-react", async importOriginal => ({
  ...await importOriginal<typeof import("@eclosion-tech/trellis-react")>(),
  AuthoredComponentView: (props: AuthoredComponentViewProps) => { mocks.view(props); return null; },
}));
import { AuthoredPageComponentRenderer } from "../components/component-renderers/AuthoredPageComponent";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it("registers separate query sessions by component node ID and closes them on source changes and unmount", async () => {
  const source: ComponentSource = {
    label: "Tasks", fields: { name: { type: "string" } },
    connection: { adapter: "pear.database", schemaId: "5", mapping: { name: "7" } },
  };
  const initial = await createAuthoredComponent("Tasks", {
    catalog: INTERFACE_REGISTRY.catalog, principal: "human", parentId: "7",
    requestId: "test", documentId: "pear-page:7:component:8", instanceId: "8",
  });
  const saved: AuthoredComponent = {
    ...initial, sources: { tasks: source, disconnected: { ...source, connection: null } },
  };
  const signals: AbortSignal[] = [];
  const cleanups: ReturnType<typeof vi.fn>[] = [];
  mocks.adapter.watch.mockImplementation((_source, _changed, signal) => {
    signals.push(signal);
    const close = vi.fn();
    cleanups.push(close);
    return close;
  });
  mocks.adapter.query.mockResolvedValue({ status: "ready", records: [], complete: true, asOf: new Date().toISOString() });
  const registry = createHostSourceRegistry();
  const root = createRoot(document.createElement("div"));
  const render = () => root.render(createElement(HostSourceRegistry.Provider, { value: registry },
    createElement(AuthoredPageComponentRenderer, {
      node: { id: 8n, surfaceId: 7n, props: JSON.stringify(saved) },
    } as BlockRendererProps)));
  try {
    await act(async () => render());
    expect(mocks.view.mock.lastCall![0]).toMatchObject({ workspace: "acme", onOpenRecord: expect.any(Function) });
    expect(Object.keys(registry.get("8")!)).toEqual(["tasks"]);
    const entry = registry.get("8")!.tasks;
    await entry.session.query({ fields: ["name"] });
    expect(mocks.adapter.query).toHaveBeenCalledWith({ ...source, mode: "query" }, { fields: ["name"] }, expect.any(Object));
    expect(mocks.adapter.subscribe).not.toHaveBeenCalled();
    saved.sources = { tasks: { ...source, label: "Updated" } };
    await act(async () => render());
    expect(registry.get("8")!.tasks).not.toBe(entry);
    expect(signals[0].aborted).toBe(true);
    expect(cleanups[0]).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
  expect(registry.get("8")).toBeUndefined();
  expect(signals).toHaveLength(2);
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(cleanups[1]).toHaveBeenCalledTimes(1);
});
