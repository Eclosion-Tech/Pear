// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { connectionIdentity, type ComponentDataAdapter, type ComponentSource } from "@eclosion-tech/trellis";
import { RecordDetailPanel, useOpenRecordPanel } from "../components/component-renderers/RecordDetailPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const source: ComponentSource = {
  label: "Tasks", fields: { name: { type: "string" } },
  connection: { adapter: "pear.database", schemaId: "5", mapping: { name: "7" } },
};
type PanelState = ReturnType<typeof useOpenRecordPanel>;
let root: Root | undefined;
let container: HTMLDivElement;
let current: PanelState;
let other: PanelState;
const dialog = () => document.querySelector('[role="dialog"]');
const ref = async (surfaceId = "100") => ({
  workspace: "acme", surfaceId, source: "tasks", recordId: "private-record-11",
  connectionIdentity: await connectionIdentity(source.connection!),
});
async function mount(adapter: ComponentDataAdapter, initialSource: ComponentSource = source) {
  let connected = initialSource;
  function Host({ surfaceId }: { surfaceId: string }) {
    const state = useOpenRecordPanel("acme", surfaceId);
    if (surfaceId === "100") current = state;
    else other = state;
    return state.openRecord && createElement(RecordDetailPanel, {
      key: JSON.stringify(state.openRecord), recordRef: state.openRecord,
      source: connected, adapter, onClose: state.onClose,
    });
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = () => root!.render(createElement(Fragment, null,
    createElement(Host, { surfaceId: "100" }), createElement(Host, { surfaceId: "200" })));
  await act(async () => render());
  return async (next: ComponentSource) => {
    connected = next;
    await act(async () => render());
  };
}
async function textEventually(text: string) {
  const deadline = Date.now() + 1000;
  // Keep asynchronous connection hashing and the ensuing read inside act.
  while (!dialog()?.textContent?.includes(text) && Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  }
  expect(dialog()?.textContent).toContain(text);
}
async function navigate(action: () => void) {
  await act(async () => {
    const popped = new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true }));
    action();
    await popped;
  });
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  window.history.replaceState(null, "");
  vi.restoreAllMocks();
});

it("opens without changing the URL, closes by popping history, and re-reads on Forward", async () => {
  const read = vi.fn<NonNullable<ComponentDataAdapter["read"]>>().mockResolvedValue({
    status: "ready", record: { id: "private-record-11", values: { name: "First read" } },
  });
  window.history.replaceState({ existingPageState: true }, "");
  const url = window.location.href;
  const length = window.history.length;
  const push = vi.spyOn(window.history, "pushState");
  const back = vi.spyOn(window.history, "back");
  await mount({ read });
  const record = await ref();
  await act(async () => current.onOpenRecord(record));
  await textEventually("First read");
  expect(push).toHaveBeenCalledWith({ pearOpenRecord: record }, "");
  expect(window.location.href).toBe(url);
  expect(window.history.length).toBe(length + 1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(dialog()?.querySelector("input")).toBeNull();
  expect(other.openRecord).toBeNull();
  await navigate(() => (dialog()!.querySelector("button") as HTMLButtonElement).click());
  expect(back).toHaveBeenCalledTimes(1);
  expect(dialog()).toBeNull();
  expect(window.history.state).toEqual({ existingPageState: true });
  read.mockResolvedValue({ status: "denied", message: "Access revoked" });
  await navigate(() => window.history.forward());
  await textEventually("Access revoked");
  expect(read).toHaveBeenCalledTimes(2);
  expect(dialog()?.textContent).not.toContain("First read");
  expect(window.location.href).toBe(url);
  await navigate(() => window.history.back());
  expect(dialog()).toBeNull();
});

it("restores an existing history reference on mount and rejects a reconnected source", async () => {
  window.history.replaceState({ pearOpenRecord: await ref() }, "");
  const read = vi.fn<NonNullable<ComponentDataAdapter["read"]>>().mockResolvedValue({
    status: "ready", record: { id: "private-record-11", values: { name: "Restored" } },
  });
  const reconnect = await mount({ read });
  await textEventually("Restored");
  expect(read).toHaveBeenCalledTimes(1);
  await reconnect({ ...source, connection: { adapter: "pear.database", schemaId: "99", mapping: { name: "7" } } });
  await textEventually("source is unavailable or has changed");
  expect(dialog()?.textContent).not.toContain("Restored");
  expect(read).toHaveBeenCalledTimes(1);
});

it("only the owning surface opens, and Back restores the previous surface", async () => {
  const read = vi.fn<NonNullable<ComponentDataAdapter["read"]>>().mockResolvedValue({ status: "unavailable" });
  await mount({ read });
  const first = await ref(), second = await ref("200");
  await act(async () => current.onOpenRecord(first));
  await textEventually("unavailable");
  await act(async () => other.onOpenRecord(second));
  await textEventually("unavailable");
  expect(current.openRecord).toBeNull();
  expect(other.openRecord).toEqual(second);
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await navigate(() => window.history.back());
  await textEventually("unavailable");
  expect(current.openRecord).toEqual(first);
  expect(other.openRecord).toBeNull();
  expect(read).toHaveBeenCalledTimes(3);
});

it("ignores malformed history and references for another workspace", async () => {
  const read = vi.fn();
  window.history.replaceState({ pearOpenRecord: { source: "tasks" } }, "");
  await mount({ read });
  expect(dialog()).toBeNull();
  await act(async () => {
    window.history.replaceState({ pearOpenRecord: { ...await ref(), workspace: "elsewhere" } }, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  });
  expect(dialog()).toBeNull();
  expect(read).not.toHaveBeenCalled();
});
