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

/** True when the spec would produce at least one child under the root. */
export function specHasContent(spec: RenderUiSpec): boolean {
  return Boolean(
    (spec.title && spec.title.trim()) ||
      (spec.markdown && spec.markdown.trim()) ||
      (spec.controls && spec.controls.length > 0),
  );
}

export function buildComponentTreeV1Blob(spec: RenderUiSpec): string {
  const nodes: WireNode[] = [];
  let nextId = 1;

  const rootId = nextId++;
  nodes.push({
    id: rootId,
    parent_id: null,
    component_type: "Container",
    props: "{}",
    order: 0,
    yjs_b64: null,
  });

  let order = 0;
  const pushText = (
    componentType: string,
    props: Record<string, unknown>,
    text: string,
  ) => {
    nodes.push({
      id: nextId++,
      parent_id: rootId,
      component_type: componentType,
      props: JSON.stringify(props),
      order: order++,
      yjs_b64: Buffer.from(richTextBlockToYjsBytes(text)).toString("base64"),
    });
  };
  const pushControl = (componentType: string, props: Record<string, unknown>) => {
    nodes.push({
      id: nextId++,
      parent_id: rootId,
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

  return JSON.stringify({ v: "component_tree_v1", root_id: rootId, nodes });
}
