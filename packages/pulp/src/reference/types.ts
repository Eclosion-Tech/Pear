import type { ComponentType, ReactNode } from "react";
import type { BlockId, BlockTree, PulpConfig, PulpMutations } from "../types";

export type BlockReferenceTarget = { surfaceId: BlockId; blockId?: BlockId };
export type ReferenceSource = {
  tree: BlockTree;
  /** Unwrapped storage mutations; each occurrence owns its undo timeline. */
  mutations: PulpMutations;
  readOnly?: boolean;
  label?: string;
  config?: Partial<PulpConfig>;
};
export type ReferenceSourceProps = {
  target: BlockReferenceTarget;
  children: (source: ReferenceSource) => ReactNode;
};
export type ReferenceAdapter = {
  Source: ComponentType<ReferenceSourceProps>;
  parseLink: (value: string) => BlockReferenceTarget | null;
  href: (target: BlockReferenceTarget) => string;
};

export function parseReferenceProps(json: string): BlockReferenceTarget | null {
  try {
    const value = JSON.parse(json);
    const id = (input: unknown) => typeof input === "string" && /^[1-9]\d*$/.test(input)
      && BigInt(input) <= 18446744073709551615n ? BigInt(input) : null;
    const surfaceId = id(value?.surfaceId);
    const blockId = value?.blockId == null ? undefined : id(value.blockId);
    return surfaceId != null && blockId !== null ? { surfaceId, blockId } : null;
  } catch { return null; }
}

export function referenceProps(target: BlockReferenceTarget): string {
  return JSON.stringify({ surfaceId: String(target.surfaceId),
    ...(target.blockId == null ? {} : { blockId: String(target.blockId) }) });
}

/** Keep navigation, selection, and structural operations inside the included subtree. */
export function referenceTree(tree: BlockTree, target: BlockReferenceTarget): BlockTree {
  const root = target.blockId == null ? tree.root : tree.byId.get(target.blockId) ?? null;
  const byId: BlockTree["byId"] = new Map();
  const byParent: BlockTree["byParent"] = new Map();
  const yjs: BlockTree["yjs"] = new Map();
  const visit = (id: BlockId) => {
    const node = tree.byId.get(id);
    if (!node || node.surfaceId !== target.surfaceId || node.deletedAt != null || byId.has(id)) return;
    byId.set(id, node);
    const children = (tree.byParent.get(id) ?? []).filter((child) => !byId.has(child.id)
      && child.surfaceId === target.surfaceId && child.deletedAt == null);
    byParent.set(id, children);
    const state = tree.yjs.get(id);
    if (state) yjs.set(id, state);
    children.forEach((child) => visit(child.id));
  };
  if (root) visit(root.id);
  return { root: root && byId.has(root.id) ? root : null, byId, byParent, yjs,
    defs: tree.defs, loading: tree.loading };
}
