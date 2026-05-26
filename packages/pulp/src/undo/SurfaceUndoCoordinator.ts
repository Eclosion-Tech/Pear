import type * as Y from "yjs";
import type { BlockId, BlockTree, PulpMutations } from "../types";

type InsertArgs = {
  parentId: BlockId;
  componentType: string;
  propsJson: string;
  afterSiblingId?: BlockId;
};

type YjsUndoEntry = {
  kind: "yjs";
  componentId: BlockId;
  undoManager: Y.UndoManager;
};

type StructuralUndoEntry = {
  kind: "structural";
  undo: () => void | Promise<void>;
  redo: () => void | Promise<void>;
};

export type UndoEntry = YjsUndoEntry | StructuralUndoEntry;

/**
 * Surface-level undo / redo coordinator — one chronological timeline per
 * (surface, user) mixing Yjs text edits and structural substrate ops.
 *
 * See `docs/PEAR_WEB_RENDERER.md` § Cross-block undo / redo.
 */
export class SurfaceUndoCoordinator {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  /** Suppresses stack recording while applying undo/redo. */
  private applying = false;
  private pendingInsert: InsertArgs | null = null;
  private getTree: (() => BlockTree) | null = null;
  private baseMutations: PulpMutations | null = null;

  /** Bind tree accessor + base mutations before `wrapMutations`. */
  bind(getTree: () => BlockTree, base: PulpMutations): void {
    this.getTree = getTree;
    this.baseMutations = base;
  }

  /**
   * Wrap host mutations so local structural gestures push inverse entries
   * onto this coordinator's timeline. Pass the result to `<PulpProvider>`.
   */
  wrapMutations(
    base: PulpMutations,
    getTree: () => BlockTree,
  ): PulpMutations {
    this.bind(getTree, base);
    const self = this;
    return {
      saveYjsState: base.saveYjsState,
      insertBlock(args) {
        self.armPendingInsert(args);
        void base.insertBlock(args);
      },
      deleteBlock(args) {
        self.recordDelete(args, base, getTree);
        void base.deleteBlock(args);
      },
      moveBlock(args) {
        self.recordMove(args, base, getTree);
        void base.moveBlock(args);
      },
      updateBlockProps(args) {
        self.recordPropsUpdate(args, base, getTree);
        void base.updateBlockProps(args);
      },
      restoreBlock: base.restoreBlock
        ? (args) => void base.restoreBlock!(args)
        : undefined,
    };
  }

  /** Called when a new block row arrives — resolves pending insert undo. */
  handleNodeInsert(componentId: BlockId): void {
    const pending = this.pendingInsert;
    if (!pending) return;
    this.pendingInsert = null;
    const base = this.baseMutations;
    if (!base) return;
    this.pushStructural({
      undo: () => base.deleteBlock({ componentId }),
      redo: () => {
        if (base.restoreBlock) {
          void base.restoreBlock({ componentId });
        } else {
          void base.insertBlock(pending);
        }
      },
    });
  }

  registerYjsUndoManager(
    componentId: BlockId,
    undoManager: Y.UndoManager,
  ): () => void {
    const onAdded = () => {
      if (this.applying) return;
      this.clearRedo();
      this.undoStack.push({ kind: "yjs", componentId, undoManager });
    };
    undoManager.on("stack-item-added", onAdded);
    return () => {
      undoManager.off("stack-item-added", onAdded);
    };
  }

  async undo(): Promise<boolean> {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.applying = true;
    try {
      if (entry.kind === "yjs") {
        entry.undoManager.undo();
      } else {
        await entry.undo();
      }
      this.redoStack.push(entry);
      return true;
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn("[pulp/undo] undo failed, skipping entry:", err);
      }
      return false;
    } finally {
      this.applying = false;
    }
  }

  async redo(): Promise<boolean> {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    this.applying = true;
    try {
      if (entry.kind === "yjs") {
        entry.undoManager.redo();
      } else {
        await entry.redo();
      }
      this.undoStack.push(entry);
      return true;
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn("[pulp/undo] redo failed, skipping entry:", err);
      }
      return false;
    } finally {
      this.applying = false;
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private armPendingInsert(args: InsertArgs): void {
    this.clearRedo();
    this.pendingInsert = args;
  }

  private recordDelete(
    args: { componentId: BlockId },
    base: PulpMutations,
    getTree: () => BlockTree,
  ): void {
    if (this.applying) return;
    const node = getTree().byId.get(args.componentId);
    if (!node || node.parentId == null) return;
    this.clearRedo();
    const insertArgs: InsertArgs = {
      parentId: node.parentId!,
      componentType: node.componentType,
      propsJson: node.props,
      afterSiblingId: this.predecessorId(getTree(), node),
    };
    this.pushStructural({
      undo: () => {
        if (base.restoreBlock) {
          void base.restoreBlock({ componentId: args.componentId });
        } else {
          void base.insertBlock(insertArgs);
        }
      },
      redo: () => void base.deleteBlock(args),
    });
  }

  private recordMove(
    args: {
      componentId: BlockId;
      newParentId: BlockId;
      afterSiblingId?: BlockId;
    },
    base: PulpMutations,
    getTree: () => BlockTree,
  ): void {
    if (this.applying) return;
    const node = getTree().byId.get(args.componentId);
    if (!node || node.parentId == null) return;
    const oldParentId = node.parentId;
    const oldAfterSiblingId = this.predecessorId(getTree(), node);
    this.clearRedo();
    this.pushStructural({
      undo: () =>
        void base.moveBlock({
          componentId: args.componentId,
          newParentId: oldParentId,
          afterSiblingId: oldAfterSiblingId,
        }),
      redo: () => void base.moveBlock(args),
    });
  }

  private recordPropsUpdate(
    args: { componentId: BlockId; propsJson: string },
    base: PulpMutations,
    getTree: () => BlockTree,
  ): void {
    if (this.applying) return;
    const node = getTree().byId.get(args.componentId);
    if (!node) return;
    const oldProps = node.props;
    if (oldProps === args.propsJson) return;
    this.clearRedo();
    this.pushStructural({
      undo: () =>
        void base.updateBlockProps({
          componentId: args.componentId,
          propsJson: oldProps,
        }),
      redo: () => void base.updateBlockProps(args),
    });
  }

  private predecessorId(
    tree: BlockTree,
    node: { id: BlockId; parentId?: BlockId | null },
  ): BlockId | undefined {
    if (node.parentId == null) return undefined;
    const siblings = tree.byParent.get(node.parentId) ?? [];
    const idx = siblings.findIndex((s) => s.id === node.id);
    return idx > 0 ? siblings[idx - 1]?.id : undefined;
  }

  private pushStructural(entry: Omit<StructuralUndoEntry, "kind">): void {
    this.undoStack.push({ kind: "structural", ...entry });
  }

  private clearRedo(): void {
    this.redoStack = [];
  }
}

export const NOOP_UNDO_COORDINATOR = {
  registerYjsUndoManager: () => () => {},
  undo: async () => false,
  redo: async () => false,
  canUndo: () => false,
  canRedo: () => false,
};
