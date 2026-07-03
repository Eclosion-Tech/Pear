/**
 * Build a `component_tree_v1` blob for the `render_ui` chat tool (custom-view
 * runtime ADR, M1b-lite).
 *
 * The model describes a small read-only interface (title + markdown body +
 * optional controls); we assemble the same JSON shape `serialize_component_tree`
 * produces on the server, so the web client renders it via `<StaticComponentTree>`
 * / pulp `<BlockView>`. Text nodes carry Yjs bytes (base64) exactly like real
 * `ComponentYjsState`, reusing the worker's existing encoders.
 *
 * A message holds ONE `component_tree_json`. Multiple `render_ui` calls in a
 * turn therefore APPEND their panels into that one tree (`appendPanelToBlob`)
 * rather than overwriting — otherwise "show me a card and a checklist" would
 * silently drop all but the last panel.
 *
 * Deliberately narrow: a Container root with flat children, the text vocabulary
 * `markdownToComponentBlocks` already supports, plus Button / Input rendered
 * read-only. No dataSource, no nesting beyond the root, no interactivity — those
 * are later milestones.
 */

import {
  markdownToComponentBlocks,
  richTextBlockToYjsBytes,
} from "./rich-text-encode.js";

export type UiControl =
  | { kind: "Button"; label?: string }
  | { kind: "Input"; label?: string; placeholder?: string };

export type RenderUiSpec = {
  title?: string;
  markdown?: string;
  controls?: UiControl[];
};

type WireNode = {
  id: number;
  parent_id: number | null;
  component_type: string;
  props: string;
  order: number;
  yjs_b64: string | null;
};

type Wire = { v: string; root_id: number; nodes: WireNode[] };

const V1 = "component_tree_v1";

/** True when the spec would produce at least one child under the root. */
export function specHasContent(spec: RenderUiSpec): boolean {
  return Boolean(
    (spec.title && spec.title.trim()) ||
      (spec.markdown && spec.markdown.trim()) ||
      (spec.controls && spec.controls.length > 0),
  );
}

/**
 * Build a panel's nodes (title / body / controls) as children of `parentId`,
 * numbering ids from `startId` and orders from `startOrder`. Shared by the
 * fresh-build and append paths so both stay identical.
 */
function buildPanelChildren(
  spec: RenderUiSpec,
  startId: number,
  startOrder: number,
  parentId: number,
): WireNode[] {
  const nodes: WireNode[] = [];
  let nextId = startId;
  let order = startOrder;

  const pushText = (
    componentType: string,
    props: Record<string, unknown>,
    text: string,
  ) => {
    nodes.push({
      id: nextId++,
      parent_id: parentId,
      component_type: componentType,
      props: JSON.stringify(props),
      order: order++,
      yjs_b64: Buffer.from(richTextBlockToYjsBytes(text)).toString("base64"),
    });
  };
  const pushControl = (componentType: string, props: Record<string, unknown>) => {
    nodes.push({
      id: nextId++,
      parent_id: parentId,
      component_type: componentType,
      props: JSON.stringify(props),
      order: order++,
      yjs_b64: null,
    });
  };

  if (spec.title && spec.title.trim()) {
    pushText("Heading", { level: 1 }, spec.title.trim());
  }
  if (spec.markdown && spec.markdown.trim()) {
    for (const block of markdownToComponentBlocks(spec.markdown)) {
      pushText(block.componentType, block.props, block.text);
    }
  }
  for (const c of spec.controls ?? []) {
    if (c.kind === "Button") {
      pushControl("Button", { label: c.label ?? "Button" });
    } else if (c.kind === "Input") {
      pushControl("Input", {
        ...(c.label != null ? { label: c.label } : {}),
        ...(c.placeholder != null ? { placeholder: c.placeholder } : {}),
      });
    }
  }
  return nodes;
}

export function buildComponentTreeV1Blob(spec: RenderUiSpec): string {
  const rootId = 1;
  const root: WireNode = {
    id: rootId,
    parent_id: null,
    component_type: "Container",
    props: "{}",
    order: 0,
    yjs_b64: null,
  };
  const children = buildPanelChildren(spec, rootId + 1, 0, rootId);
  const wire: Wire = { v: V1, root_id: rootId, nodes: [root, ...children] };
  return JSON.stringify(wire);
}

/**
 * Append a panel to an existing `component_tree_v1` blob so multiple render_ui
 * calls in one turn accumulate under the same root instead of overwriting.
 * Falls back to a fresh build when there is no (valid) existing blob.
 */
export function appendPanelToBlob(
  existingJson: string | null | undefined,
  spec: RenderUiSpec,
): string {
  const existing = parseWire(existingJson);
  if (!existing) return buildComponentTreeV1Blob(spec);

  let maxId = 0;
  let maxOrder = -1;
  for (const n of existing.nodes) {
    if (n.id > maxId) maxId = n.id;
    if (n.parent_id === existing.root_id && n.order > maxOrder) maxOrder = n.order;
  }
  const added = buildPanelChildren(
    spec,
    maxId + 1,
    maxOrder + 1,
    existing.root_id,
  );
  const wire: Wire = {
    v: V1,
    root_id: existing.root_id,
    nodes: [...existing.nodes, ...added],
  };
  return JSON.stringify(wire);
}

/** Parse + shallow-validate an existing blob; null if unusable (→ fresh build). */
function parseWire(json: string | null | undefined): Wire | null {
  if (!json) return null;
  try {
    const w = JSON.parse(json) as Wire;
    if (
      w &&
      w.v === V1 &&
      typeof w.root_id === "number" &&
      Array.isArray(w.nodes) &&
      w.nodes.some((n) => n.id === w.root_id)
    ) {
      return w;
    }
  } catch {
    /* fall through */
  }
  return null;
}
