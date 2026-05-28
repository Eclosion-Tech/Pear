import type { EditorView } from "prosemirror-view";
import type { SurfaceFocusValue, FocusPlacement } from "../focus/SurfaceFocusCoordinator";
import type { BlockId, BlockNode, BlockTree, BlockTypeDefinition, PulpMutations } from "../types";

/** Default registry defs for editor behavior tests. */
export const BUILTIN_DEFS: Record<string, BlockTypeDefinition> = {
  Container: {
    componentType: "Container",
    propSchema: "{}",
    acceptsChildren: true,
    hasYjsState: false,
  },
  RichText: {
    componentType: "RichText",
    propSchema: "{}",
    acceptsChildren: false,
    hasYjsState: true,
  },
  Heading: {
    componentType: "Heading",
    propSchema: "{}",
    acceptsChildren: true,
    hasYjsState: true,
  },
  BulletListItem: {
    componentType: "BulletListItem",
    propSchema: "{}",
    acceptsChildren: true,
    hasYjsState: true,
  },
  NumberedListItem: {
    componentType: "NumberedListItem",
    propSchema: "{}",
    acceptsChildren: true,
    hasYjsState: true,
  },
};

export type FlatBlockSpec = {
  id: number;
  type: string;
  parent: number | null;
  props?: string;
  order?: number;
};

/**
 * Build a `BlockTree` from a flat block list. Uses numeric ids converted to bigint.
 * Siblings are sorted by `order` then `id`.
 */
export function makeTree(
  blocks: FlatBlockSpec[],
  opts: { surfaceId?: number; extraDefs?: Record<string, BlockTypeDefinition> } = {},
): BlockTree {
  const surfaceId = BigInt(opts.surfaceId ?? 1);
  const byId = new Map<BlockId, BlockNode>();
  const byParent = new Map<BlockId | null, BlockNode[]>();
  const defs = new Map<string, BlockTypeDefinition>([
    ...Object.entries(BUILTIN_DEFS),
    ...Object.entries(opts.extraDefs ?? {}),
  ]);

  for (const spec of blocks) {
    const node: BlockNode = {
      id: BigInt(spec.id),
      surfaceId,
      parentId: spec.parent == null ? null : BigInt(spec.parent),
      componentType: spec.type,
      props: spec.props ?? "{}",
      order: spec.order ?? spec.id,
    };
    byId.set(node.id, node);
  }

  for (const node of byId.values()) {
    const key = node.parentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(node);
    byParent.set(key, list);
  }

  for (const list of byParent.values()) {
    list.sort((a, b) => {
      const ao = Number(a.order);
      const bo = Number(b.order);
      return ao !== bo ? ao - bo : Number(a.id - b.id);
    });
  }

  const root =
    [...byId.values()].find((n) => n.parentId == null && n.componentType === "Container") ??
    [...byId.values()].find((n) => n.parentId == null) ??
    null;

  return {
    root,
    byId,
    byParent,
    defs,
    yjs: new Map(),
    loading: false,
  };
}

export function node(tree: BlockTree, id: number): BlockNode {
  const n = tree.byId.get(BigInt(id));
  if (!n) throw new Error(`missing block id=${id}`);
  return n;
}

export type MockFocusCalls = {
  requestFocus: Array<[BlockId, FocusPlacement | undefined]>;
  armForInsert: Array<{
    parentId: BlockId;
    afterSiblingId?: BlockId;
    opts?: Parameters<SurfaceFocusValue["armForInsert"]>[2];
  }>;
};

export function createMockFocus(
  editors: Map<BlockId, EditorView> = new Map(),
): SurfaceFocusValue & { calls: MockFocusCalls } {
  const calls: MockFocusCalls = { requestFocus: [], armForInsert: [] };

  return {
    calls,
    armForInsert(parentId, afterSiblingId, opts) {
      calls.armForInsert.push({ parentId, afterSiblingId, opts });
    },
    isAwaitingInsert: () => false,
    isHandoffSource: () => false,
    claimFocus: () => null,
    ackFocus: () => {},
    matchPendingInsert: () => null,
    registerFocusable: () => () => {},
    requestFocus(id, placement) {
      calls.requestFocus.push([id, placement]);
    },
    registerEditor: () => () => {},
    getEditor: (id) => editors.get(id),
    consumeInitialDoc: () => undefined,
  };
}

export type MockMutationsCalls = {
  insertBlock: PulpMutations["insertBlock"] extends (...args: infer A) => unknown ? A[] : never;
  deleteBlock: Array<{ componentId: BlockId }>;
  moveBlock: Array<{
    componentId: BlockId;
    newParentId: BlockId;
    afterSiblingId?: BlockId;
  }>;
  updateBlockProps: Array<{ componentId: BlockId; propsJson: string }>;
  saveYjsState: Array<{ componentId: BlockId; data: Uint8Array }>;
};

export function createMockMutations(): PulpMutations & { calls: MockMutationsCalls } {
  const calls: MockMutationsCalls = {
    insertBlock: [],
    deleteBlock: [],
    moveBlock: [],
    updateBlockProps: [],
    saveYjsState: [],
  };

  return {
    calls,
    insertBlock(args) {
      calls.insertBlock.push(args);
    },
    deleteBlock(args) {
      calls.deleteBlock.push(args);
    },
    moveBlock(args) {
      calls.moveBlock.push(args);
    },
    updateBlockProps(args) {
      calls.updateBlockProps.push(args);
    },
    saveYjsState(args) {
      calls.saveYjsState.push(args);
    },
  };
}

/** Minimal EditorView stub for keymap handler tests. */
export function mockEditorView(state: EditorView["state"]): EditorView {
  return { state } as EditorView;
}
