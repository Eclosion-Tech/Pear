/**
 * Component-tree authoring for the MCP surface — the missing primitive that
 * lets an AI user build UI on a page rather than only write prose into one.
 *
 * `update_page_content` converts markdown, so it can only ever produce the six
 * markdown-shaped types (RichText, Heading, the three list items, MarkdownTable).
 * Everything else in the registry — Repeater, Container, Button, Form, Input,
 * PageLink, Image — was unreachable, and so were `style` tokens and a repeater's
 * `dataSource`, because those live in props no tool could write.
 *
 * These wrap the existing reducers rather than adding new ones: `insert_component`,
 * `update_component_props`, `delete_component`. Authority is unchanged —
 * `require_page_write` inside each reducer is authoritative.
 *
 * ## Why single-node inserts rather than a nested batch
 *
 * A batch would need a new reducer taking a nested spec. Composing from single
 * inserts costs one round trip per node but needs no schema change, and the ids
 * come back as you go, so an agent building a repeater (Repeater → Container →
 * PageLink + recursion Container) threads parents naturally.
 */

import type { StdbTransport } from "../api-endpoint";
import { selectSurfaceNodes } from "./component-tree";
import { encodeOption, encodeU64 } from "./encode";
import { discoverAllocatedId, readCounter } from "./ids";
import { reducerErrorMessage } from "./errors";

export type ComponentSummary = {
  component_id: number;
  component_type: string;
  parent_id: number | null;
  order: number;
  props: unknown;
  children: ComponentSummary[];
};

/**
 * The page's live component tree, with ids, types and parsed props.
 *
 * `get_page` returns rendered text, which is useless for authoring: to insert
 * under something, or to reconfigure a repeater, you need the node id and the
 * current props. Props are parsed rather than returned as a JSON string so a
 * caller can read `dataSource` / `style` without a second decode step.
 */
export async function getPageComponents(
  transport: StdbTransport,
  pageId: number,
): Promise<
  | { ok: true; page_id: number; root: ComponentSummary | null }
  | { ok: false; error: string }
> {
  const nodes = (await selectSurfaceNodes(transport, pageId)).filter((n) => !n.deleted);
  if (nodes.length === 0) {
    return { ok: false, error: "Page has no component tree (not a ComponentTree page?)" };
  }

  const byParent = new Map<number | null, typeof nodes>();
  for (const n of nodes) {
    const key = n.parentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(n);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);

  const build = (id: number | null): ComponentSummary[] =>
    (byParent.get(id) ?? []).map((n) => {
      let props: unknown = {};
      try {
        props = JSON.parse(n.props || "{}");
      } catch {
        props = { _unparseable: n.props };
      }
      return {
        component_id: n.id,
        component_type: n.componentType,
        parent_id: n.parentId,
        order: n.order,
        props,
        children: build(n.id),
      };
    });

  const roots = build(null);
  return { ok: true, page_id: pageId, root: roots[0] ?? null };
}

export type AuthorResult =
  | { ok: true; component_id: number; component_type: string }
  | { ok: false; error: string };

/**
 * Insert one component under `parent_id`.
 *
 * The reducer returns nothing, so the new id is recovered from the gap-free
 * `id_counter` — with a fallback that re-selects candidates in the allocated
 * range, because a concurrent writer can burn ids between the two reads.
 */
export async function insertComponent(
  transport: StdbTransport,
  args: {
    parentId: number;
    componentType: string;
    props: unknown;
    afterSiblingId?: number;
  },
): Promise<AuthorResult> {
  const { parentId, componentType, props, afterSiblingId } = args;
  if (!componentType.trim()) {
    return { ok: false, error: "component_type is required" };
  }

  let propsJson: string;
  try {
    propsJson = JSON.stringify(props ?? {});
  } catch {
    return { ok: false, error: "props must be JSON-serialisable" };
  }

  const before = await readCounter(transport, "component_node");
  try {
    await transport.call("insert_component", [
      encodeU64(parentId),
      componentType,
      propsJson,
      encodeOption(afterSiblingId === undefined ? undefined : encodeU64(afterSiblingId)),
    ]);
  } catch (err) {
    return { ok: false, error: reducerErrorMessage(err) };
  }

  const id = await discoverAllocatedId(
    transport,
    "component_node",
    before,
    async (lo, hi) => {
      // Concurrent writer burned ids: find ours by (parent, type) in the range.
      const nodes = await selectSurfaceNodes(transport, parentId);
      const mine = nodes.filter(
        (n) =>
          n.id > lo &&
          n.id <= hi &&
          n.parentId === parentId &&
          n.componentType === componentType &&
          !n.deleted,
      );
      return mine.length > 0 ? mine[mine.length - 1]!.id : null;
    },
  );

  if (id === null) {
    return {
      ok: false,
      error: "insert_component committed but the new component id could not be determined",
    };
  }
  return { ok: true, component_id: id, component_type: componentType };
}

/**
 * Replace a component's props.
 *
 * Whole-object replace, matching the reducer. Read current props with
 * `get_page_components` and merge before writing, or a partial update silently
 * drops the keys it omits.
 */
export async function updateComponentProps(
  transport: StdbTransport,
  componentId: number,
  props: unknown,
): Promise<{ ok: boolean; component_id: number; error?: string }> {
  let propsJson: string;
  try {
    propsJson = JSON.stringify(props ?? {});
  } catch {
    return { ok: false, component_id: componentId, error: "props must be JSON-serialisable" };
  }
  try {
    await transport.call("update_component_props", [encodeU64(componentId), propsJson]);
  } catch (err) {
    return { ok: false, component_id: componentId, error: reducerErrorMessage(err) };
  }
  return { ok: true, component_id: componentId };
}

export async function deleteComponent(
  transport: StdbTransport,
  componentId: number,
): Promise<{ ok: boolean; component_id: number; error?: string }> {
  try {
    await transport.call("delete_component", [encodeU64(componentId)]);
  } catch (err) {
    return { ok: false, component_id: componentId, error: reducerErrorMessage(err) };
  }
  return { ok: true, component_id: componentId };
}
