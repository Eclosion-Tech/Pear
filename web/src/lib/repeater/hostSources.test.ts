// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ComponentQueryResult, ComponentSource } from "@eclosion-tech/trellis";
import type { QueryResolver, RepeaterRow } from "@eclosion-tech/pulp";
import { createHostSourceRegistry, HostSourceRegistry, subscribeHostQuery, type HostSource } from "./hostSources";

const table = vi.hoisted(() => ({ rows: [] }));
vi.mock("spacetimedb/react", () => ({ useTable: () => [table.rows] }));
import { useQueryResolver } from "./queryResolver";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const config = { v: 1 as const, entity: { kind: "host" as const, surfaceId: 7n, source: "tasks" } };
const source: ComponentSource = { label: "Tasks", mode: "query", fields: { title: { type: "string" }, day: { type: "date" } }, connection: null };
const ready = (title = "Task"): ComponentQueryResult => ({ status: "ready", records: [{ id: "11", values: { title, day: "2026-11-04" } }], complete: true, asOf: "2026-11-04T00:00:00Z" });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function entry() {
  const listeners = new Set<() => void>();
  const query = vi.fn(async () => ready());
  const host: HostSource = { source, session: { query, onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } } };
  return { host, query, listeners, change: () => { for (const listener of listeners) listener(); } };
}

it("registers by surface, notifies changes and protects a replacement from stale cleanup", () => {
  const registry = createHostSourceRegistry();
  const changed = vi.fn();
  const unsubscribe = registry.subscribe(changed);
  const first = { tasks: entry().host }, second = { tasks: entry().host };
  const close = registry.register("7", first);
  registry.register("7", second);
  close();
  expect(registry.get("7")).toBe(second);
  expect(changed).toHaveBeenCalledTimes(2);
  registry.unregister("7");
  expect(registry.get("7")).toBeUndefined();
  expect(changed).toHaveBeenCalledTimes(3);
  unsubscribe();
  registry.register("8", first);
  expect(changed).toHaveBeenCalledTimes(3);
});

it("delivers empty rows for missing sessions and resolves a later registration with declared fields and bounded sort/limit", async () => {
  const registry = createHostSourceRegistry(), value = entry(), deliver = vi.fn();
  const close = subscribeHostQuery(registry, { ...config, sort: [{ property: "unknown", dir: "asc" }, { property: "day", dir: "desc" }], limit: 1000 }, deliver);
  expect(deliver).toHaveBeenLastCalledWith([]);
  registry.register("7", { tasks: value.host });
  await flush();
  expect(value.query).toHaveBeenCalledWith({ fields: ["title", "day"], sort: [{ field: "day", direction: "desc" }], limit: 200 });
  expect(deliver).toHaveBeenLastCalledWith([{ id: 11n, title: "Task", day: "2026-11-04" }]);
  const missing = vi.fn();
  subscribeHostQuery(registry, { ...config, entity: { ...config.entity, source: "toString" } }, missing)();
  expect(missing).toHaveBeenLastCalledWith([]);
  registry.unregister("7");
  expect(deliver).toHaveBeenLastCalledWith([]);
  expect(value.listeners.size).toBe(0);
  close();
});

it("requeries on session changes, retaining identity only for unchanged ids and values", async () => {
  const registry = createHostSourceRegistry(), value = entry();
  registry.register("7", { tasks: value.host });
  const delivered: ReadonlyArray<RepeaterRow>[] = [];
  const close = subscribeHostQuery(registry, { ...config, limit: 5, filter: [{ property: "title", op: "contains", value: "Task" }] }, rows => delivered.push(rows));
  await flush();
  expect(value.query).toHaveBeenCalledWith({ fields: ["title", "day"], filter: [{ field: "title", op: "contains", value: "Task" }], limit: 5 });
  value.change();
  await flush();
  expect(delivered[1][0]).toBe(delivered[0][0]);
  expect(delivered[1]).not.toBe(delivered[0]);
  value.query.mockResolvedValue(ready("Changed"));
  value.change();
  await flush();
  expect(delivered[2][0]).not.toBe(delivered[1][0]);
  expect(delivered[2][0].title).toBe("Changed");
  registry.register("7", { tasks: { ...value.host } });
  await flush();
  expect(delivered[3][0]).toBe(delivered[2][0]);
  close();
  value.change();
  registry.unregister("7");
  expect(delivered).toHaveLength(4);
  expect(value.listeners.size).toBe(0);
});

it("drops late results after invalidation, replacement, removal and unsubscribe", async () => {
  const registry = createHostSourceRegistry(), value = entry(), deliver = vi.fn();
  const pending: ((result: ComponentQueryResult) => void)[] = [];
  value.query.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  registry.register("7", { tasks: value.host });
  const close = subscribeHostQuery(registry, config, deliver);
  value.change();
  value.change();
  value.change();
  expect(value.query).toHaveBeenCalledTimes(1);
  pending[0](ready("Old"));
  await flush();
  expect(deliver).not.toHaveBeenCalled();
  expect(value.query).toHaveBeenCalledTimes(2);
  pending[1](ready("New"));
  await flush();
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(deliver.mock.calls[0][0][0].title).toBe("New");
  value.change();
  const replacement = entry();
  registry.register("7", { tasks: replacement.host });
  await flush();
  pending[2](ready("Old session"));
  await flush();
  expect(deliver.mock.calls.at(-1)?.[0][0].title).toBe("Task");
  registry.register("7", { tasks: value.host });
  registry.unregister("7");
  pending[3](ready());
  await flush();
  expect(deliver).toHaveBeenLastCalledWith([]);
  registry.register("7", { tasks: value.host });
  close();
  const count = deliver.mock.calls.length;
  pending[4](ready());
  await flush();
  expect(deliver).toHaveBeenCalledTimes(count);
});

it("clears rows on non-ready results or query rejection and honors zero limit", async () => {
  const registry = createHostSourceRegistry(), value = entry(), deliver = vi.fn();
  registry.register("7", { tasks: value.host });
  const close = subscribeHostQuery(registry, config, deliver);
  await flush();
  for (const status of ["denied", "unavailable", "error"] as const) {
    value.query.mockResolvedValue({ ...ready(), status, records: [] });
    value.change();
    await flush();
    expect(deliver).toHaveBeenLastCalledWith([]);
  }
  value.query.mockRejectedValue(new Error("Unavailable"));
  value.change();
  await flush();
  expect(deliver).toHaveBeenLastCalledWith([]);
  close();
  value.query.mockClear();
  subscribeHostQuery(registry, { ...config, limit: 0 }, deliver)();
  expect(value.query).not.toHaveBeenCalled();
  expect(deliver).toHaveBeenLastCalledWith([]);
  subscribeHostQuery(null, config, deliver)();
  expect(deliver).toHaveBeenLastCalledWith([]);
});

it("the resolver routes host entities through context and never redelivers database rows", async () => {
  const registry = createHostSourceRegistry(), value = entry(), deliver = vi.fn();
  registry.register("7", { tasks: value.host });
  let resolver!: QueryResolver;
  function Probe() { resolver = useQueryResolver(); return null; }
  const container = document.createElement("div"), root = createRoot(container);
  let close: (() => void) | undefined;
  try {
    await act(async () => root.render(createElement(HostSourceRegistry.Provider, { value: registry }, createElement(Probe))));
    close = resolver.subscribe(config, deliver);
    await flush();
    expect(value.query).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls.at(-1)?.[0][0].id).toBe(11n);
    table.rows = [];
    await act(async () => root.render(createElement(HostSourceRegistry.Provider, { value: registry }, createElement(Probe))));
    expect(deliver).toHaveBeenCalledTimes(1);
    registry.unregister("7");
    expect(deliver).toHaveBeenLastCalledWith([]);
  } finally {
    close?.();
    await act(async () => root.unmount());
  }
});


it("serializes queries across repeaters sharing a session and continues after rejection", async () => {
  const registry = createHostSourceRegistry(), value = entry();
  let inFlight = 0, peak = 0;
  const pending: { resolve: (result: ComponentQueryResult) => void; reject: (error: Error) => void }[] = [];
  value.query.mockImplementation(() => {
    peak = Math.max(peak, ++inFlight);
    return new Promise<ComponentQueryResult>((resolve, reject) => pending.push({
      resolve: result => { inFlight--; resolve(result); },
      reject: error => { inFlight--; reject(error); },
    }));
  });
  registry.register("7", { tasks: value.host });
  // Different entries still share the same session queue.
  registry.register("8", { tasks: { ...value.host } });
  const deliveries = Array.from({ length: 12 }, () => vi.fn());
  const closes = deliveries.map((deliver, index) => subscribeHostQuery(registry, {
    ...config, entity: { ...config.entity, surfaceId: index % 2 ? 8n : 7n },
  }, deliver));
  expect(value.query).toHaveBeenCalledTimes(1);
  for (let index = 0; index < deliveries.length; index++) {
    expect(pending).toHaveLength(index + 1);
    if (index === 0) pending[index].reject(new Error("Unavailable"));
    else pending[index].resolve(ready());
    // Allow the queued query and delivery promise chains to settle.
    for (let turn = 0; turn < 8; turn++) await flush();
  }
  expect(peak).toBe(1);
  expect(deliveries[0]).toHaveBeenLastCalledWith([]);
  for (const deliver of deliveries.slice(1)) expect(deliver.mock.calls.at(-1)?.[0][0].id).toBe(11n);
  closes.forEach(close => close());
});

it("fails closed on undeclared filter fields instead of widening the result set", async () => {
  const registry = createHostSourceRegistry(), value = entry(), deliver = vi.fn();
  value.query.mockResolvedValue(ready());
  registry.register("7", { tasks: value.host });
  const close = subscribeHostQuery(registry, { ...config, filter: [
    { property: "unknown", op: "eq", value: "x" },
    { property: "title", op: "contains", value: "Task" },
  ] }, deliver);
  await flush();
  expect(value.query).not.toHaveBeenCalled();
  expect(deliver.mock.calls.at(-1)?.[0]).toEqual([]);
  close();
});
it("skips only noncanonical record ids and keeps rows on stale results", async () => {
  const registry = createHostSourceRegistry(), value = entry(), deliver = vi.fn();
  value.query.mockResolvedValueOnce({ ...ready(), records: ["external", "-1", "01", "1.5", "", " 1", "+1", "0x10", "1e2", "0", "11", "123456789012345678901234567890"].map(id => ({ id, values: { title: id } })) });
  registry.register("7", { tasks: value.host });
  const close = subscribeHostQuery(registry, { ...config, filter: [{ property: "title", op: "contains", value: "Task" }] }, deliver);
  await flush();
  expect(value.query).toHaveBeenCalledWith({ fields: ["title", "day"], filter: [{ field: "title", op: "contains", value: "Task" }], limit: 200 });
  const delivered = deliver.mock.calls.at(-1)?.[0];
  expect(delivered.map((row: RepeaterRow) => row.id)).toEqual([0n, 11n, 123456789012345678901234567890n]);
  value.query.mockResolvedValueOnce({ status: "unavailable", records: [], complete: false, asOf: "", message: "This result is out of date.", stale: true });
  const before = deliver.mock.calls.length;
  value.change();
  await flush();
  expect(deliver.mock.calls.length).toBe(before);
  close();
});
