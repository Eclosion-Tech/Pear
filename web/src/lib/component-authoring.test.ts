// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AuthoredComponentView } from "@eclosion-tech/trellis-react";
import {
  createAuthoredComponent,
  commitAuthoredComponent,
  createExternalJsonAdapter,
  type AuthoredComponent,
  type ComponentCommand,
  type ComponentDataAdapter,
  type ComponentDataSnapshot,
} from "@eclosion-tech/trellis";
import { INTERFACE_REGISTRY } from "@pear/trellis-ui";
import { PEAR_SLASH_ITEMS } from "../components/component-renderers/pearSlashItems";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null,
  container: HTMLDivElement;
let agentEdit: (command: ComponentCommand) => Promise<void>;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
});
async function mount(initial: AuthoredComponent, extra: object = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  let saved = initial,
    update: (saved: AuthoredComponent) => void;
  agentEdit = async (command) => {
    await act(async () => {
      saved = await commitAuthoredComponent(
        saved,
        {
          baseRevision: saved.document.revision,
          requestId: `agent:${crypto.randomUUID()}`,
          command,
        },
        { catalog: INTERFACE_REGISTRY.catalog, principal: "agent" },
      );
      update(saved);
    });
  };
  function Host() {
    const [current, setCurrent] = useState(initial);
    update = setCurrent;
    return createElement(AuthoredComponentView, {
      saved: current,
      catalog: INTERFACE_REGISTRY.catalog,
      principalKey: "human",
      canEdit: true,
      ...extra,
      onCommit: async (request, signal) => {
        if (signal.aborted) throw new Error("ended");
        saved = await commitAuthoredComponent(saved, request, {
          catalog: INTERFACE_REGISTRY.catalog,
          principal: "human",
        });
        setCurrent(saved);
        return saved;
      },
    });
  }
  await act(async () => {
    root!.render(createElement(Host));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
  return () => saved;
}
const blank = () =>
  createAuthoredComponent("Blank", {
    catalog: INTERFACE_REGISTRY.catalog,
    principal: "human",
    parentId: "page",
    requestId: "blank",
    documentId: "doc",
    instanceId: "component",
  });
function label(name: string) {
  const element = [...document.querySelectorAll("label")]
    .filter((label) => !label.closest("[hidden]"))
    .find((label) => label.firstChild?.textContent?.trim() === name);
  expect(element, `label ${name}`).toBeDefined();
  return element!.querySelector("input,select,textarea")! as HTMLInputElement;
}
async function fill(element: HTMLInputElement, value: string) {
  await act(async () => {
    const proto =
      element.tagName === "SELECT"
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(
      new Event(element.tagName === "SELECT" ? "change" : "input", {
        bubbles: true,
      }),
    );
  });
}
async function click(name: string) {
  const button = [...document.querySelectorAll("button")]
    .filter((button) => !button.closest("[hidden]"))
    .find((button) => button.textContent === name);
  expect(button, `button ${name}`).toBeDefined();
  await act(async () => {
    button!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
it("the human builder adds a real building block to a blank component and saves text without a preset", async () => {
  expect(
    PEAR_SLASH_ITEMS.filter(
      (item) => item.componentType === "TrellisPanel",
    ).map((item) => ({ label: item.label, props: item.defaultProps })),
  ).toEqual([
    {
      label: "New component",
      props: { kind: "component", title: "Untitled component" },
    },
  ]);
  const saved = await mount(await blank());
  await click("Build a component");
  await fill(label("Building block"), "RichText");
  await click("Add building block");
  expect(saved().document.nodes).toHaveLength(2);
  await fill(label("Text"), "Built from scratch");
  await click("Save building block");
  expect(saved().document.nodes[1].text).toEqual([
    { text: "Built from scratch" },
  ]);
  expect(container.textContent).toContain("Built from scratch");
  expect(saved().document.template).toBeUndefined();
});
it("the actual live table renders a read-only API as read-only and confirms an explicit API write from source data", async () => {
  let name = "Source value",
    writes = 0;
  const source = {
    label: "Contacts",
    fields: { name: { type: "string" as const, writable: true } },
    connection: {
      adapter: "external.json" as const,
      readUrl: "https://example.test/rows",
      recordsPath: "",
      idField: "id",
    },
  };
  let saved = await blank();
  saved = await commitAuthoredComponent(
    saved,
    {
      baseRevision: 0,
      requestId: "table",
      command: {
        kind: "edit",
        configuration: {
          title: "Connected",
          actions: {},
          bindings: {},
          sources: { contacts: source },
        },
        operations: [
          {
            op: "insertNode",
            node: {
              id: "table",
              parentId: saved.document.rootId,
              type: "DataTable",
              order: 0,
              props: { source: "contacts", columns: ["name"] },
            },
          },
        ],
      },
    },
    { catalog: INTERFACE_REGISTRY.catalog, principal: "human" },
  );
  const adapter = createExternalJsonAdapter({
    fetch: (async (_url, init) => {
      if (init?.method === "PATCH") {
        writes++;
        name = JSON.parse(String(init.body)).name;
      }
      return new Response(JSON.stringify([{ id: "one", name }]));
    }) as typeof fetch,
  });
  await mount(saved, { dataAdapters: { "external.json": adapter } });
  expect(
    container.querySelector("table"),
    container.textContent ?? "",
  ).not.toBeNull();
  expect(container.querySelector("table")!.textContent).toContain(
    "Source value",
  );
  expect(container.querySelector("table input")).toBeNull();
  expect(container.textContent).toContain("Read only");
  expect(writes).toBe(0);
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  saved = await commitAuthoredComponent(
    saved,
    {
      baseRevision: 1,
      requestId: "enable",
      command: {
        kind: "edit",
        operations: [],
        configuration: {
          title: saved.title,
          actions: {},
          bindings: {},
          sources: {
            contacts: {
              ...source,
              connection: {
                ...source.connection,
                write: {
                  url: "https://example.test/rows/{id}",
                  method: "PATCH",
                },
              },
            },
          },
        },
      },
    },
    { catalog: INTERFACE_REGISTRY.catalog, principal: "human" },
  );
  await mount(saved, { dataAdapters: { "external.json": adapter } });
  await fill(label("name (one)"), "Changed in source");
  await click("Save to source");
  expect(writes).toBe(1);
  expect(name).toBe("Changed in source");
  expect(container.textContent).toContain("Saved to source.");
  expect(
    (container.querySelector("table input") as HTMLInputElement).value,
  ).toBe("Changed in source");
});

it("a concurrent AI edit rejects stale human settings while retaining the unsent draft until explicit reload", async () => {
  const saved = await mount(await blank());
  await click("Build a component");
  await fill(label("Building block"), "RichText");
  await click("Add building block");
  await fill(label("Text"), "My unsent change");
  await agentEdit({
    kind: "edit",
    operations: [
      {
        op: "setText",
        target: { id: saved().document.nodes[1].id },
        text: [{ text: "Agent change" }],
      },
    ],
  });
  await click("Save building block");
  expect(saved().document.nodes[1].text).toEqual([{ text: "Agent change" }]);
  expect(label("Text").value).toBe("My unsent change");
  expect(document.body.textContent).toContain("Your draft is retained");
  await click("Reload saved block");
  expect(label("Text").value).toBe("Agent change");
});
it("an unconfirmed source draft and its retry identity survive a temporary loss of readable source data", async () => {
  let deliver: (snapshot: ComponentDataSnapshot) => void = () => {};
  const requests: string[] = [];
  const snapshot: ComponentDataSnapshot = {
    status: "ready",
    records: [{ id: "one", values: { name: "Source value" } }],
    writableFields: ["name"],
  };
  const adapter: ComponentDataAdapter = {
    subscribe(_source, emit) {
      deliver = emit;
      emit(snapshot);
      return () => {};
    },
    async write(_source, intent) {
      requests.push(intent.requestId);
      return requests.length === 1
        ? { status: "uncertain", message: "Not confirmed" }
        : { status: "confirmed", record: { id: "one", values: intent.values } };
    },
  };
  let saved = await blank();
  saved = await commitAuthoredComponent(
    saved,
    {
      baseRevision: 0,
      requestId: "table",
      command: {
        kind: "edit",
        configuration: {
          title: "Connected",
          actions: {},
          bindings: {},
          sources: {
            contacts: {
              label: "Contacts",
              fields: { name: { type: "string", writable: true } },
              connection: {
                adapter: "external.json",
                readUrl: "https://example.test/rows",
                recordsPath: "",
                idField: "id",
                write: {
                  url: "https://example.test/rows/{id}",
                  method: "PATCH",
                },
              },
            },
          },
        },
        operations: [
          {
            op: "insertNode",
            node: {
              id: "table",
              parentId: saved.document.rootId,
              type: "DataTable",
              order: 0,
              props: { source: "contacts", columns: ["name"] },
            },
          },
        ],
      },
    },
    { catalog: INTERFACE_REGISTRY.catalog, principal: "human" },
  );
  await mount(saved, { dataAdapters: { "external.json": adapter } });
  await fill(label("name (one)"), "Retain this draft");
  await click("Save to source");
  await act(async () =>
    deliver({
      status: "error",
      records: [],
      writableFields: [],
      message: "Temporary outage",
    }),
  );
  expect(container.querySelector("table")).toBeNull();
  await act(async () => deliver(snapshot));
  expect(label("name (one)").value).toBe("Retain this draft");
  await click("Retry source write");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  expect(container.textContent).toContain("Saved to source.");
});
async function createForm() {
  let saved = await blank();
  return commitAuthoredComponent(
    saved,
    {
      baseRevision: 0,
      requestId: "form",
      command: {
        kind: "edit",
        configuration: {
          title: "Entry form",
          bindings: {},
          sources: {
            entries: {
              label: "Entries",
              fields: { name: { type: "string", writable: true } },
              connection: {
                adapter: "external.json",
                readUrl: "https://example.test/rows",
                recordsPath: "",
                idField: "id",
                create: {
                  url: "https://example.test/rows",
                  method: "POST",
                  idempotency: "key",
                },
              },
            },
          },
          actions: {
            create: {
              kind: "create",
              source: "entries",
              input: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
              fields: { name: "name" },
              clearOnSuccess: true,
              message: "Entry created.",
            },
          },
        },
        operations: [
          {
            op: "insertNode",
            node: {
              id: "name",
              parentId: saved.document.rootId,
              type: "Input",
              order: 0,
              props: { name: "name", label: "Name", required: true },
            },
          },
          {
            op: "insertNode",
            node: {
              id: "submit",
              parentId: saved.document.rootId,
              type: "Button",
              order: 1,
              props: { label: "Add entry" },
              action: { slot: "create", input: { name: { field: "name" } } },
            },
          },
        ],
      },
    },
    { catalog: INTERFACE_REGISTRY.catalog, principal: "human" },
  );
}
it("opening the modal keeps page input private and mounted, and closing restores the same input", async () => {
  const adapter: ComponentDataAdapter = {
    subscribe(_source, emit) {
      emit({
        status: "ready",
        records: [],
        writableFields: [],
        creatableFields: ["name"],
      });
      return () => {};
    },
    async create() {
      throw new Error("not invoked");
    },
  };
  await mount(await createForm(), {
    dataAdapters: { "external.json": adapter },
  });
  const input = container.querySelector("input")!;
  await fill(input, "Private unfinished entry");
  expect(document.querySelector("dialog")).toBeNull();
  await click("Edit component");
  const dialog = document.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  expect(container.querySelector("input")).toBe(input);
  expect(input.value).toBe("Private unfinished entry");
  expect(
    (
      dialog.querySelector(
        '[aria-label="Component preview"] input',
      ) as HTMLInputElement
    ).value,
  ).toBe("");
  await click("Done");
  expect(dialog.open).toBe(false);
  expect(input.value).toBe("Private unfinished entry");
  await click("Edit component");
  expect(document.querySelector("dialog")).toBe(dialog);
});
it("create keeps uncertain inputs and retry identity, then clears only values unchanged since submission", async () => {
  const calls: { id: string; name: unknown }[] = [];
  let resolve: ((value: any) => void) | undefined;
  const adapter: ComponentDataAdapter = {
    subscribe(_source, emit) {
      emit({
        status: "ready",
        records: [],
        writableFields: [],
        creatableFields: ["name"],
      });
      return () => {};
    },
    async create(_source, intent) {
      calls.push({ id: intent.requestId, name: intent.values.name });
      if (calls.length === 1)
        return {
          status: "uncertain",
          message: "Response lost — retry this submission.",
        };
      return new Promise((done) => {
        resolve = done;
      });
    },
  };
  await mount(await createForm(), {
    dataAdapters: { "external.json": adapter },
  });
  const input = container.querySelector("input")!;
  await click("Add entry");
  expect(calls).toHaveLength(0);
  await fill(input, "Submitted");
  await click("Add entry");
  expect(input.value).toBe("Submitted");
  expect(container.textContent).toContain("Response lost");
  await click("Add entry");
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  await fill(input, "A newer draft");
  await act(async () => {
    resolve!({
      status: "confirmed",
      record: { id: "real", values: { name: "Submitted" } },
    });
  });
  expect(input.value).toBe("A newer draft");
  expect(container.textContent).toContain("Entry created.");
});
it("confirmed creation clears the submitted field and an adapter without creation authority disables the control", async () => {
  let allow = true;
  const adapter: ComponentDataAdapter = {
    subscribe(_source, emit) {
      emit({
        status: "ready",
        records: [],
        writableFields: [],
        creatableFields: allow ? ["name"] : [],
      });
      return () => {};
    },
    async create(_source, intent) {
      return {
        status: "confirmed",
        record: { id: "real", values: intent.values },
      };
    },
  };
  await mount(await createForm(), {
    dataAdapters: { "external.json": adapter },
  });
  const input = container.querySelector("input")!;
  await fill(input, "Clear this after success");
  await click("Add entry");
  expect(input.value).toBe("");
  await act(async () => root!.unmount());
  root = null;
  container.remove();
  allow = false;
  await mount(await createForm(), {
    dataAdapters: { "external.json": adapter },
  });
  expect(
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Add entry",
    )!.disabled,
  ).toBe(true);
});
