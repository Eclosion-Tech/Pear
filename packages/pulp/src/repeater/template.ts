/**
 * Template extraction and per-row prop resolution.
 *
 * A repeater's template is not a separate artifact — it is the `Repeater`
 * node's ordinary stored children (D6: "template editing is just editing the
 * repeater's stored children"). This module reads those rows out of the tree,
 * numbers each position, and resolves `{{row.*}}` references against a row.
 *
 * Row references are lookup-only, never computation (D5's last fence).
 */

import type { BlockId, BlockNode, BlockTree } from "../types";
import type { RepeaterRow } from "./dataSource";

/**
 * One position in the template. `slot` is a pre-order index, stable for a
 * given stored template, and feeds `virtualId` so instantiated nodes keep
 * their identity across re-materializations.
 */
export type TemplateNode = {
  /** Stored node this position was read from. */
  sourceId: BlockId;
  componentType: string;
  /** Raw props JSON from the stored node, placeholders unresolved. */
  props: string;
  children: TemplateNode[];
  /**
   * Recursion point: instantiate the whole template again for each child row.
   * Marked with a `repeatChildren: true` prop on the stored node. Exactly one
   * position may carry it; extras are ignored with a warning, because a second
   * recursion point has no coherent meaning.
   */
  repeatChildren: boolean;
  slot: number;
};

/** The stored prop that marks a template position as the recursion point. */
export const REPEAT_CHILDREN_PROP = "repeatChildren";

function readProps(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Build the template forest from a repeater's stored children.
 *
 * Returns an empty array when the repeater has no children — an
 * unconfigured repeater, which the renderer surfaces as an empty-template
 * notice rather than rendering nothing.
 */
export function buildTemplate(
  tree: BlockTree,
  repeaterId: BlockId,
): TemplateNode[] {
  let slot = 0;
  let sawRecursion = false;

  const build = (node: BlockNode): TemplateNode => {
    const mySlot = slot++;
    const props = readProps(node.props);
    let repeatChildren = props[REPEAT_CHILDREN_PROP] === true;

    if (repeatChildren && sawRecursion) {
      repeatChildren = false;
      if (typeof console !== "undefined") {
        console.warn(
          `[pulp/repeater] template for repeater ${repeaterId} has more than one ` +
            `${REPEAT_CHILDREN_PROP} position; ignoring the one on node ${node.id}.`,
        );
      }
    }
    if (repeatChildren) sawRecursion = true;

    const stored = tree.byParent.get(node.id) ?? [];
    return {
      sourceId: node.id,
      componentType: node.componentType,
      props: node.props,
      children: stored.map(build),
      repeatChildren,
      slot: mySlot,
    };
  };

  return (tree.byParent.get(repeaterId) ?? []).map(build);
}

/**
 * Slot of the recursion point, or null for a flat template.
 *
 * The materializer needs the slot (not just a boolean) because nested rows
 * hang off the *virtual* node at that position — their `parentId` is that
 * node's synthetic id, which is derived from the slot.
 */
export function findRecursionSlot(template: TemplateNode[]): number | null {
  const walk = (t: TemplateNode): number | null => {
    if (t.repeatChildren) return t.slot;
    for (const c of t.children) {
      const found = walk(c);
      if (found !== null) return found;
    }
    return null;
  };
  for (const t of template) {
    const found = walk(t);
    if (found !== null) return found;
  }
  return null;
}

/** True when the template can nest rows (the sidebar's sub-page case). */
export function hasRecursionPoint(template: TemplateNode[]): boolean {
  return findRecursionSlot(template) !== null;
}

/**
 * Structural fingerprint of a template.
 *
 * The template is rebuilt from the tree on every delivery (it is read out of
 * `byParent`, which the host reindexes each time), but the materializer must
 * *survive* deliveries — its whole value is the cache it accumulates. Keying
 * the materializer on template identity would throw that cache away every
 * delivery and silently degrade to naive. Keying on this signature recreates it
 * only when the stored template genuinely changed.
 */
export function templateSignature(template: TemplateNode[]): string {
  const parts: string[] = [];
  const walk = (t: TemplateNode) => {
    parts.push(
      `${t.slot}:${String(t.sourceId)}:${t.componentType}:${t.repeatChildren ? 1 : 0}:${t.props}`,
    );
    t.children.forEach(walk);
  };
  template.forEach(walk);
  return parts.join("|");
}

/* ------------------------------------------------------------------ */
/* Prop resolution                                                     */
/* ------------------------------------------------------------------ */

const PLACEHOLDER = /\{\{row\.([A-Za-z0-9_ -]+)\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{row\.([A-Za-z0-9_ -]+)\}\}$/;

/** JSON has no bigint; stringify so resolved props stay serializable. */
function scalarize(v: unknown): unknown {
  return typeof v === "bigint" ? String(v) : v;
}

function interpolate(value: string, row: RepeaterRow): unknown {
  // A prop whose entire value is one placeholder keeps the row value's type
  // (a number stays a number), which matters for typed prop schemas. Embedded
  // placeholders always produce a string.
  const whole = WHOLE_PLACEHOLDER.exec(value);
  if (whole) {
    const v = row[whole[1]];
    return v === undefined ? null : scalarize(v);
  }
  return value.replace(PLACEHOLDER, (_, field: string) => {
    const v = row[field];
    return v == null ? "" : String(v);
  });
}

function resolveValue(value: unknown, row: RepeaterRow): unknown {
  if (typeof value === "string") return interpolate(value, row);
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, row));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, row);
    return out;
  }
  return value;
}

/**
 * Resolve one template position's props against a row → JSON string, matching
 * the `props` shape every renderer already expects.
 *
 * The internal `repeatChildren` marker is stripped: it is template metadata,
 * not something a renderer should see on a materialized node.
 */
export function resolveProps(template: TemplateNode, row: RepeaterRow): string {
  const props = readProps(template.props);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k === REPEAT_CHILDREN_PROP) continue;
    out[k] = resolveValue(v, row);
  }
  return JSON.stringify(out);
}
