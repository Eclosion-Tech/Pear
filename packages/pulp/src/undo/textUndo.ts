import { Plugin } from "prosemirror-state";
import * as Y from "yjs";
import { ySyncPluginKey, yUndoPlugin, yUndoPluginKey } from "y-prosemirror";
import { PROSEMIRROR_FRAGMENT_KEY } from "../rich-text/richTextSchema";

const managers = new WeakMap<Y.Doc, Y.UndoManager>();

/** Text history lives as long as its document, including viewport unmounts. */
export function textUndoManager(doc: Y.Doc): Y.UndoManager {
  let manager = managers.get(doc);
  if (!manager) {
    manager = new Y.UndoManager(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_KEY), {
      trackedOrigins: new Set([ySyncPluginKey, null]),
      captureTransaction: (tr) => tr.meta.get("addToHistory") !== false,
    });
    managers.set(doc, manager);
  }
  return manager;
}

/**
 * yUndoPlugin normally destroys even a supplied manager when its view unmounts.
 * Retain its state and relative-caret behavior, but release only view listeners.
 * Y.UndoManager itself listens for the owning Y.Doc's destruction.
 */
export function textUndoPlugin(manager: Y.UndoManager): Plugin {
  const plugin = yUndoPlugin({ undoManager: manager });
  return new Plugin({
    ...plugin.spec,
    view(view) {
      const binding = ySyncPluginKey.getState(view.state).binding;
      const added = ({ stackItem }: { stackItem: Y.UndoManager["undoStack"][number] }) => {
        if (binding) stackItem.meta.set(binding, yUndoPluginKey.getState(view.state)?.prevSel);
      };
      const popped = ({ stackItem }: { stackItem: Y.UndoManager["undoStack"][number] }) => {
        if (binding) binding.beforeTransactionSelection = stackItem.meta.get(binding) || binding.beforeTransactionSelection;
      };
      manager.on("stack-item-added", added);
      manager.on("stack-item-popped", popped);
      return { destroy() {
        manager.off("stack-item-added", added);
        manager.off("stack-item-popped", popped);
      } };
    },
  });
}
