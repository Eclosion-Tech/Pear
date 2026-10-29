// From server/spacetimedb: cargo build --example interface_commit
// Then node examples/interface_conformance.mjs (uses installed vendor packages).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const { createInterfaceRegistry, createRetainedInterface, commitRetainedInterface, readRetainedInterface, canonicalJson } = await import(new URL("../../../worker/node_modules/@eclosion-tech/trellis/dist/index.js", import.meta.url));
import library from "../src/pages/components/trellis_interfaces.json" with { type: "json" };
const registry = await createInterfaceRegistry(library);
const child = spawn(resolve(process.env.CARGO_TARGET_DIR ?? new URL("../target", import.meta.url).pathname, "debug/examples/interface_commit"), [], { stdio: ["pipe", "pipe", "inherit"] });
let output = "", pending = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => { output += chunk; while (output.includes("\n")) { const end = output.indexOf("\n"), line = output.slice(0, end); output = output.slice(end + 1); pending.shift()?.resolve(JSON.parse(line)); } });
child.on("error", error => { for (const request of pending.splice(0)) request.reject(error); });
child.on("exit", code => { for (const request of pending.splice(0)) request.reject(new Error(`Rust helper exited ${code}`)); });
function rust(request) { return new Promise((resolve, reject) => { pending.push({ resolve, reject }); child.stdin.write(JSON.stringify(request) + "\n"); }); }
let count = 0;
async function create(templateId, parameters = {}) {
  const descriptor = { templateId, templateVersion: "1.0.0", parameters };
  const js = await createRetainedInterface(descriptor, { registry, principal: "human", parentId: "1", requestId: "create", documentId: "pear-page:1:component:2", instanceId: "pear-component:2" });
  const native = await rust({ operation: "create", surfaceId: 1, componentId: 2, parentId: "1", principal: "human", requestId: "create", intentJson: canonicalJson(descriptor) });
  assert.equal(native.ok, true, native.error); assert.deepEqual(JSON.parse(native.saved), js); count++;
  return js;
}
async function commit(saved, command, { requestId = `request:${count}`, baseRevision = saved.document.revision, principal = "agent", reject = false } = {}) {
  const request = { command, requestId, baseRevision };
  const js = await commitRetainedInterface(saved, request, { registry, principal }).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  const native = await rust({ operation: "commit", existing: canonicalJson(saved), baseRevision, principal, requestId, commandJson: canonicalJson(command) });
  assert.equal(native.ok, js.ok, `${canonicalJson(command)} JS=${js.error?.message} Rust=${native.error}`);
  assert.equal(js.ok, !reject, js.error?.message ?? "Expected rejection");
  if (js.ok) assert.deepEqual(native.saved === null ? saved : JSON.parse(native.saved), js.value);
  count++; return js.value ?? saved;
}
async function invalid(saved, mutate) {
  const changed = structuredClone(saved); mutate(changed);
  assert.throws(() => readRetainedInterface(changed, registry));
  assert.equal((await rust({ operation: "parse", existing: canonicalJson(changed) })).ok, false);
  count++;
}
try {
  let saved = await create("trellis.checklist", { headingLevel: 3, firstDone: true, title: "Unicode 🍐 <>&\u2028" });
  const title = { kind: "parameters", parameters: { title: "Agent update", firstDone: false, headingLevel: 6 } };
  saved = await commit(saved, title, { requestId: "same" });
  saved = await commit(saved, title, { requestId: "same", baseRevision: 0 });
  await commit(saved, title, { requestId: "same", baseRevision: 1, reject: true });
  await commit(saved, title, { requestId: "same", baseRevision: 0, principal: "another", reject: true });
  await commit(saved, { kind: "parameters", parameters: { firstDone: "true" } }, { reject: true });
  const root = saved.document.rootId;
  saved = await commit(saved, { kind: "patch", operations: [
    { op: "insertNode", node: { id: "z-parent", parentId: root, type: "Container", order: 7, props: {} } },
    { op: "insertNode", node: { id: "a-child", parentId: "z-parent", type: "ChecklistItem", order: 0, props: { checked: false }, text: [{ text: "Third task" }], action: { slot: "checklist.toggle", input: {} } } },
    { op: "moveNode", target: { key: "second-task" }, parentId: root, order: 0 },
  ] });
  const node = saved.document.nodes.find(node => node.id === "a-child");
  const event = { documentId: saved.document.documentId, revision: saved.document.revision, nodeId: node.id, slot: "checklist.toggle", invocationId: "toggle:1", input: {} };
  const action = { kind: "action", event }, actionRevision = saved.document.revision;
  saved = await commit(saved, action, { requestId: "toggle:1" });
  saved = await commit(saved, action, { requestId: "toggle:1", baseRevision: actionRevision });
  await commit(saved, action, { reject: true });
  await commit(saved, { kind: "parameters", parameters: { title: "Forked" } }, { reject: true });
  for (const operation of [
    { op: "moveNode", target: { id: "z-parent" }, parentId: "a-child", order: 0 },
    { op: "removeSubtree", target: { id: root } },
    { op: "setProps", target: { id: "a-child" }, props: { checked: "yes" } },
    { op: "setText", target: { id: "missing" }, text: [{ text: "No" }] },
    { op: "insertNode", node: { id: "unsafe", parentId: root, type: "Button", order: 4, props: {}, action: { slot: "notes.save", input: { value: "stolen" } } } },
  ]) await commit(saved, { kind: "patch", operations: [operation] }, { reject: true });
  saved = await commit(saved, { kind: "patch", operations: [{ op: "removeSubtree", target: { id: "z-parent" } }] });
  assert.deepEqual(saved.document.retiredIds, ["z-parent", "a-child"]);
  await commit(saved, { kind: "patch", operations: [{ op: "insertNode", node }] }, { reject: true });
  for (const mutate of [
    value => { value.document.template.actionBindings.toggle = "notes.save"; },
    value => { value.document.template.mapping.root = "forged"; },
    value => { value.document.template.hash = "0".repeat(64); },
    value => { value.document.nodes[0].props.script = "evil"; },
    value => { value.receipts[0].revision = Number.MAX_SAFE_INTEGER; },
    value => { value.document.nodes[1].parentId = "missing"; },
    value => { delete value.document.nodes[0].parentId; },
  ]) await invalid(saved, mutate);
  let note = await create("trellis.note-form");
  const button = note.document.nodes.find(node => node.action);
  const noteEvent = value => ({ documentId: note.document.documentId, revision: note.document.revision, nodeId: button.id, slot: "notes.save", invocationId: `save:${count}`, input: { value } });
  for (const value of ["", "  \uFEFF ", "x".repeat(4001)]) await commit(note, { kind: "action", event: noteEvent(value) }, { reject: true });
  note = await commit(note, { kind: "action", event: noteEvent("A committed 🍐 note") });
  assert.equal(note.document.nodes.find(node => node.key === "saved-note").text[0].text, "A committed 🍐 note");
  // Receipt eviction is bounded and survives repeated round trips through either implementation.
  for (let i = 0; i < 130; i++) saved = await commit(saved, { kind: "patch", operations: [{ op: "setText", target: { key: "title" }, text: [{ text: `Revision ${i}` }] }] });
  assert.equal(saved.receipts.length, 128);
  console.log(`PASS ${count} TypeScript/Rust transition and rejection comparisons`);
} finally { child.stdin.end(); }
