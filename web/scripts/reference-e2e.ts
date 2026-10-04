/** Disposable localhost test: registry, independent placement, persistence, and source permissions. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { HttpStdbTransport } from "../src/lib/api-endpoint/http-transport";
import { richTextBlockToYjsBytes } from "@eclosion-tech/pulp/rich-text/encode";

async function main() {
  const base = process.argv[2] ?? "http://127.0.0.1:3109";
  assert(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Localhost only");
  const name = `pear-reference-e2e-${Date.now()}`;
  const url = `${base}/v1/database/${name}`;
  const sockets: WebSocket[] = [];
  const none = { none: [] };
  const identity = async () => await (await fetch(`${base}/v1/identity`, { method: "POST" })).json() as { identity: string; token: string };
  const publisher = await identity();
  const admin = new HttpStdbTransport({ baseUrl: base, dbName: name, token: publisher.token });
  async function actor() {
    const account = await identity();
    const socket = new WebSocket(`${url.replace("http:", "ws:")}/subscribe?token=${encodeURIComponent(account.token)}`, "v1.json.spacetimedb");
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Connect timeout")), 10000);
      socket.addEventListener("message", (event) => {
        if (JSON.parse(String(event.data)).IdentityToken) { clearTimeout(timer); resolve(); }
      });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(Error("Connection failed")); });
    });
    return { ...account, db: new HttpStdbTransport({ baseUrl: base, dbName: name, token: account.token }) };
  }
  try {
    const wasm = await readFile(new URL("../../server/spacetimedb/target/wasm32-unknown-unknown/release/server.wasm", import.meta.url));
    const publish = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${publisher.token}` }, body: wasm });
    assert(publish.ok, await publish.text());
    await admin.call("run_pending_migrations", []);
    await admin.call("run_pending_migrations", []);
    const defs = await admin.sql<{ component_type: string; accepts_children: boolean }>("SELECT * FROM component_type_definition WHERE component_type = 'Reference'");
    assert.equal(defs.length, 1); assert.equal(defs[0].accepts_children, false);

    const owner = await actor(), reader = await actor();
    await owner.db.call("register", ["owner@example.test", "Owner", "reference-test-password"]);
    await owner.db.call("create_local_user", ["reader@example.test", "Reader", "reference-test-password"]);
    await reader.db.call("login", ["reader@example.test", "reference-test-password"]);
    for (const title of ["Source", "Composition"]) await owner.db.call("create_component_tree_page", [none, { doc: [] }, title]);
    const pages = await admin.sql<{ id: number; title: string }>("SELECT id, title FROM page");
    const source = pages.find((p) => p.title === "Source")!.id;
    const composition = pages.find((p) => p.title === "Composition")!.id;
    // HTTP SQL represents Option<T> as [0, value] (some) or [1, []] (none).
    type Option<T> = [0, T] | [1, []];
    const nodes = () => admin.sql<{ id: number; surface_id: number; parent_id: Option<number>; component_type: string; props: string; deleted_at: Option<unknown> }>("SELECT * FROM component_node");
    const sourceRoot = (await nodes()).find((n) => n.surface_id === source)!.id;
    const compositionRoot = (await nodes()).find((n) => n.surface_id === composition)!.id;
    await owner.db.call("insert_component", [sourceRoot, "RichText", "{}", none]);
    const text = (await nodes()).find((n) => n.surface_id === source && n.component_type === "RichText")!.id;
    const originalState = Array.from(richTextBlockToYjsBytes("Shared source text"));
    await owner.db.call("save_component_yjs_state", [text, originalState]);
    await owner.db.call("set_page_access_rule", [source, [`0x${owner.identity}`], { write: [] }]);
    await owner.db.call("set_page_access_rule", [source, [`0x${reader.identity}`], { read: [] }]);
    await reader.db.call("insert_component", [compositionRoot, "Reference", JSON.stringify({ surfaceId: String(source), blockId: String(text) }), none]);
    const reference = (await nodes()).find((n) => n.component_type === "Reference")!.id;
    await reader.db.call("insert_component", [compositionRoot, "Container", '{"layout":"stack"}', none]);
    const nested = (await nodes()).find((n) => n.surface_id === composition && n.id !== compositionRoot && n.component_type === "Container")!.id;
    await reader.db.call("move_component", [reference, nested, none]);
    assert.deepEqual((await nodes()).find((n) => n.id === reference)!.parent_id, [0, nested]);
    assert.deepEqual(JSON.parse((await nodes()).find((n) => n.id === reference)!.props), { surfaceId: String(source), blockId: String(text) });
    assert.equal((await nodes()).find((n) => n.id === text)!.surface_id, source);
    await assert.rejects(reader.db.call("save_component_yjs_state", [text, Array.from(richTextBlockToYjsBytes("Not permitted"))]));
    await reader.db.call("delete_component", [reference]);
    assert.equal((await nodes()).find((n) => n.id === text)!.deleted_at[0], 1);
    const saved = await admin.sql<{ data: string }>(`SELECT data FROM component_yjs_state WHERE component_node_id = ${text}`);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].data, Buffer.from(originalState).toString("hex"));
    await reader.db.call("restore_component", [reference]);
    assert.equal((await nodes()).find((n) => n.id === reference)!.deleted_at[0], 1);
    console.log("PASS: idempotent reference registry migration, reference persistence, independent placement, source write permissions, and remove/restore without source deletion");
  } finally {
    sockets.forEach((socket) => socket.close());
    await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${publisher.token}` } });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
