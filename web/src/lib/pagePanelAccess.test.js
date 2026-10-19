// @vitest-environment happy-dom
// This runtime regression uses the pinned SDK implementation, including its
// private context. Keep its source types outside the application type check.
import { afterEach, expect, test, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { usePageAccess } from "../hooks/usePageAccess";
import { SpacetimeDBContext } from "../../node_modules/spacetimedb/src/react/useSpacetimeDB";
vi.mock("spacetimedb/react", () => import("../../node_modules/spacetimedb/src/react/index"));
vi.mock("../module_bindings", () => ({
  tables: Object.fromEntries(["page", "page_access_rule", "user", "module_install_meta"].map((name) => [name, {
    accessorName: name,
    sourceName: name,
    toSql: () => `SELECT * FROM ${name}`
  }]))
}));
class Cache {
  rows;
  inserts = new Set();
  updates = new Set();
  deletes = new Set();
  serial = 0;
  constructor(rows = []) {
    this.rows = rows;
  }
  iter = () => this.rows.values();
  onInsert = (listener) => {
    this.inserts.add(listener);
  };
  onUpdate = (listener) => {
    this.updates.add(listener);
  };
  onDelete = (listener) => {
    this.deletes.add(listener);
  };
  removeOnInsert = (listener) => {
    this.inserts.delete(listener);
  };
  removeOnUpdate = (listener) => {
    this.updates.delete(listener);
  };
  removeOnDelete = (listener) => {
    this.deletes.delete(listener);
  };
  update(row) {
    const before = this.rows[0];
    this.rows = [row];
    const ctx = { event: { id: String(++this.serial) } };
    for (const listener of [...this.updates]) listener(ctx, before, row);
  }
  insert(row) {
    this.rows = [...this.rows, row];
    const ctx = { event: { id: String(++this.serial) } };
    for (const listener of [...this.inserts]) listener(ctx, row);
  }
}
const principal = "a".repeat(64);
const identity = { toHexString: () => principal };
let root;
let container;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = undefined;
  container?.remove();
});
async function mount() {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const page = { id: 7n, parentId: undefined, deletedAt: undefined, updatedAt: 0 };
  const db = {
    page: new Cache([page]),
    page_access_rule: new Cache(),
    user: new Cache([{ identity, isAuthenticated: true, isAdmin: false }]),
    module_install_meta: new Cache()
  };
  const connection = {
    db,
    subscriptionBuilder() {
      let applied = () => {
      };
      const builder = {
        onApplied(callback) {
          applied = callback;
          return builder;
        },
        onError() {
          return builder;
        },
        subscribe() {
          let ended = false;
          queueMicrotask(() => {
            if (!ended) applied();
          });
          return { unsubscribe() {
            ended = true;
          }, isEnded: () => ended };
        }
      };
      return builder;
    }
  };
  const state = { identity, isActive: true, getConnection: () => connection };
  function Probe() {
    const access = usePageAccess(7n);
    return createElement("output", { "data-ready": String(access.ready) }, access.canEdit ? "Write" : "Read only");
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(SpacetimeDBContext.Provider, { value: state }, createElement(Probe)));
  });
  expect(container.textContent).toBe("Write");
  return { db, page };
}
test("saving twice keeps access after the reducer touches the page timestamp", async () => {
  const { db, page } = await mount();
  for (const updatedAt of [1, 2]) {
    await act(async () => db.page.update({ ...page, updatedAt }));
    expect(container.textContent).toBe("Write");
    expect(container.querySelector("output").dataset.ready).toBe("true");
  }
});
test("live write revocation still disables the panel and a restored grant reenables it", async () => {
  const { db } = await mount();
  const rule = { pageId: 7n, principal: { tag: "WorkspaceMember", value: identity }, permission: { tag: "Read" } };
  await act(async () => db.page_access_rule.insert(rule));
  expect(container.textContent).toBe("Read only");
  await act(async () => db.page_access_rule.update({ ...rule, permission: { tag: "Write" } }));
  expect(container.textContent).toBe("Write");
});
test("user-table updates do not revoke a loaded open page", async () => {
  const { db } = await mount();
  await act(async () => db.user.update({ identity, isAuthenticated: true, isAdmin: false, name: "Updated profile" }));
  expect(container.textContent).toBe("Write");
});
test("a deleted source disables editing and restoration restores its permission", async () => {
  const { db, page } = await mount();
  await act(async () => db.page.update({ ...page, deletedAt: 1 }));
  expect(container.textContent).toBe("Read only");
  await act(async () => db.page.update(page));
  expect(container.textContent).toBe("Write");
});
