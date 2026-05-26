/**
 * Storage-agnostic block tree types for `@eclosion-tech/pulp`.
 *
 * Pear's SpacetimeDB `ComponentNode` rows satisfy these shapes
 * structurally — the adapter layer maps substrate rows to `BlockTree`
 * without copying.
 */

export type BlockId = bigint;

/** A single node in a block tree surface. */
export type BlockNode = {
  id: BlockId;
  surfaceId: BlockId;
  parentId?: BlockId | null;
  componentType: string;
  props: string;
  order: number | bigint;
  updatedAt?: { microsSinceUnixEpoch: BlockId };
  deletedAt?: unknown | null;
};

/** Declaration-side metadata for a block type (Pear: `ComponentTypeDefinition`). */
export type BlockTypeDefinition = {
  componentType: string;
  propSchema: string;
  displayName?: string;
  acceptsChildren: boolean;
  hasYjsState?: boolean;
  isBuiltin?: boolean;
};

/** Per-block Yjs blob when the type has `hasYjsState`. */
export type BlockYjsState = {
  componentNodeId: BlockId;
  data: Uint8Array;
  updatedAt?: { microsSinceUnixEpoch: BlockId };
};

export type BlockTree = {
  root: BlockNode | null;
  byId: Map<BlockId, BlockNode>;
  byParent: Map<BlockId | null, BlockNode[]>;
  defs: Map<string, BlockTypeDefinition>;
  yjs: Map<BlockId, BlockYjsState>;
  loading: boolean;
};

export type PropValidationResult = import("./componentProps").ValidationResult;

export type PulpMutations = {
  insertBlock: (args: {
    parentId: BlockId;
    componentType: string;
    propsJson: string;
    afterSiblingId?: BlockId;
  }) => void | Promise<void>;
  deleteBlock: (args: { componentId: BlockId }) => void | Promise<void>;
  moveBlock: (args: {
    componentId: BlockId;
    newParentId: BlockId;
    afterSiblingId?: BlockId;
  }) => void | Promise<void>;
  updateBlockProps: (args: {
    componentId: BlockId;
    propsJson: string;
  }) => void | Promise<void>;
  saveYjsState: (args: {
    componentId: BlockId;
    data: Uint8Array;
  }) => void | Promise<void>;
  /** Soft-undelete — Pear: `restore_component`. Optional; delete undo falls back to re-insert. */
  restoreBlock?: (args: { componentId: BlockId }) => void | Promise<void>;
};

export type PulpConfig = {
  /** IndexedDB namespace prefix, e.g. `pear:my-workspace`. */
  idbPrefix: string;
  validateProps?: (
    props: string,
    schema: string,
  ) => PropValidationResult;
  /** Override slash / turn-into menu items (Pear sprint 4+). */
  slashItems?: import("./SlashMenu").SlashMenuItem[];
};

export type PulpContextValue = {
  tree: BlockTree;
  config: PulpConfig;
} & PulpMutations;

/** Minimal insert event for the surface focus coordinator. */
export type BlockInsertEvent = {
  id: BlockId;
  surfaceId: BlockId;
  parentId?: BlockId | null;
  deletedAt?: unknown | null;
};
