/**
 * Tests for the render_ui blob builder (custom-view runtime M1b-lite).
 *
 * Asserts the emitted JSON matches the `component_tree_v1` wire shape the web
 * parser expects, and that text nodes carry decodable Yjs bytes whose content
 * round-trips through pulp's read-only render path.
 *
 * Run: `npm test` (node:test via tsx).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { yDocToPlainText } from "@eclosion-tech/pulp/rich-text/yjsToHtml";
import {
  appendPanelToBlob,
  buildComponentTreeV1Blob,
  specHasContent,
  type RenderUiSpec,
} from "./component-tree-ui.js";

type WireNode = {
  id: number;
  parent_id: number | null;
  component_type: string;
  props: string;
  order: number;
  yjs_b64: string | null;
};
type Wire = { v: string; root_id: number; nodes: WireNode[] };

function decodeText(b64: string): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(b64, "base64")));
  const text = yDocToPlainText(doc);
  doc.destroy();
  return text;
}

test("specHasContent reflects whether any child would be emitted", () => {
  assert.equal(specHasContent({}), false);
  assert.equal(specHasContent({ title: "  " }), false);
  assert.equal(specHasContent({ title: "Hi" }), true);
  assert.equal(specHasContent({ markdown: "x" }), true);
  assert.equal(specHasContent({ controls: [{ kind: "Button" }] }), true);
});

test("builds a component_tree_v1 tree: Container root + title + body + controls", () => {
  const spec: RenderUiSpec = {
    title: "Weekly Summary",
    markdown: "First paragraph.\n\n- one\n- two",
    controls: [
      {
        kind: "Button",
        label: "Accept",
        automation_id: 14567,
        input: { ask_id: "$form.ask_id", decision: "accepted" },
        confirm: "Accept this ask?",
      },
      {
        kind: "Input",
        name: "ask_id",
        label: "Ask ID",
        placeholder: "type…",
        required: true,
      },
    ],
  };
  const wire = JSON.parse(buildComponentTreeV1Blob(spec)) as Wire;

  assert.equal(wire.v, "component_tree_v1");

  const root = wire.nodes.find((n) => n.id === wire.root_id)!;
  assert.equal(root.parent_id, null);
  assert.equal(root.component_type, "Container");

  // Every non-root node hangs off the root, ids are unique, orders ascending.
  const children = wire.nodes.filter((n) => n.id !== wire.root_id);
  assert.ok(children.every((n) => n.parent_id === wire.root_id));
  assert.equal(new Set(wire.nodes.map((n) => n.id)).size, wire.nodes.length);
  const orders = children.map((n) => n.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));

  const types = children.map((n) => n.component_type);
  assert.deepEqual(types, [
    "Heading",
    "RichText",
    "BulletListItem",
    "BulletListItem",
    "Button",
    "Input",
  ]);

  // Title heading: level prop + decodable text.
  const heading = children[0];
  assert.equal(JSON.parse(heading.props).level, 1);
  assert.equal(decodeText(heading.yjs_b64!), "Weekly Summary");
  assert.equal(decodeText(children[1].yjs_b64!), "First paragraph.");

  // Controls: props set, no Yjs.
  const button = children.find((n) => n.component_type === "Button")!;
  assert.deepEqual(JSON.parse(button.props), {
    label: "Accept",
    action: {
      type: "trigger_automation",
      automationId: 14567,
      input: { ask_id: "$form.ask_id", decision: "accepted" },
      confirmation: "Accept this ask?",
    },
  });
  assert.equal(button.yjs_b64, null);
  const inputProps = JSON.parse(
    children.find((n) => n.component_type === "Input")!.props,
  );
  assert.equal(inputProps.name, "ask_id");
  assert.equal(inputProps.label, "Ask ID");
  assert.equal(inputProps.placeholder, "type…");
  assert.equal(inputProps.required, true);
});

test("append accumulates panels under one root (multiple render_ui in a turn)", () => {
  // First call → fresh tree.
  const first = appendPanelToBlob(null, { title: "Card" });
  const firstWire = JSON.parse(first) as Wire;
  assert.equal(firstWire.nodes.filter((n) => n.id !== firstWire.root_id).length, 1);

  // Second call appends onto the existing blob (does NOT overwrite).
  const second = appendPanelToBlob(first, {
    title: "Checklist",
    markdown: "- [ ] a\n- [x] b",
  });
  const wire = JSON.parse(second) as Wire;

  // Single shared root; the first panel's Heading survives alongside the new one.
  assert.equal(wire.nodes.filter((n) => n.parent_id === null).length, 1);
  assert.equal(wire.root_id, firstWire.root_id);
  const children = wire.nodes.filter((n) => n.id !== wire.root_id);
  assert.ok(children.every((n) => n.parent_id === wire.root_id));

  // Ids stay unique and orders are strictly ascending across both panels.
  assert.equal(new Set(children.map((n) => n.id)).size, children.length);
  const orders = children.map((n) => n.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
  assert.equal(new Set(orders).size, orders.length);

  // Content from both panels present: two headings + two checklist items.
  assert.equal(children.filter((n) => n.component_type === "Heading").length, 2);
  assert.equal(
    children.filter((n) => n.component_type === "ChecklistItem").length,
    2,
  );
});

test("append falls back to a fresh build when the existing blob is unusable", () => {
  // (Yjs bytes carry a random clientID, so assert structure, not byte-equality.)
  for (const bad of [null, undefined, "", "{not json", '{"v":"component_tree_v2"}']) {
    const wire = JSON.parse(appendPanelToBlob(bad, { title: "X" })) as Wire;
    const roots = wire.nodes.filter((n) => n.parent_id === null);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].component_type, "Container");
    const children = wire.nodes.filter((n) => n.id !== wire.root_id);
    assert.equal(children.length, 1); // fresh single panel, not appended/duplicated
    assert.equal(children[0].component_type, "Heading");
  }
});

test("produces valid JSON for a controls-only spec (no text nodes)", () => {
  const wire = JSON.parse(
    buildComponentTreeV1Blob({ controls: [{ kind: "Button" }] }),
  ) as Wire;
  const btn = wire.nodes.find((n) => n.component_type === "Button")!;
  assert.equal(JSON.parse(btn.props).label, "Button"); // default label
});

test("renders GFM markdown as one static table component (#197)", () => {
  const wire = JSON.parse(
    buildComponentTreeV1Blob({
      markdown: "| Name | Status |\n| --- | :---: |\n| Pear | Ready |",
    }),
  ) as Wire;
  const table = wire.nodes.find((node) => node.component_type === "MarkdownTable")!;
  assert.ok(table);
  assert.equal(table.yjs_b64, null);
  assert.deepEqual(JSON.parse(table.props), {
    headers: ["Name", "Status"],
    rows: [["Pear", "Ready"]],
    alignments: ["left", "center"],
  });
});
