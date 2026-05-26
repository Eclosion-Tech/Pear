"use client";

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import {
  baseKeymap,
  chainCommands,
  exitCode,
  toggleMark,
} from "prosemirror-commands";
import {
  ySyncPlugin,
  yUndoPlugin,
  undo as yUndo,
  redo as yRedo,
} from "y-prosemirror";
import {
  richTextSchema,
  PROSEMIRROR_FRAGMENT_KEY,
} from "@/src/lib/richTextSchema";
import { useSaveComponentYjsState } from "@/src/hooks/usePages";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { FormattingToolbar } from "./FormattingToolbar";

/** Cadence — see `docs/PEAR_WEB_RENDERER.md` § Editor stack — Save cycle. */
const SAVE_INTERVAL_MS = 30_000;

/**
 * Live `RichText` editor — sprint 2 of the web renderer.
 *
 * Mounts a `y-prosemirror` view on top of the per-component Y.Doc. Wires:
 *   - IndexedDB persistence (`y-indexeddb`) per component, namespace
 *     `pear:{idbNamespace}:component:{componentId}`
 *   - 30s debounced `save_component_yjs_state` push (local-origin only;
 *     remote-origin updates skip the save loop to prevent echo)
 *   - Base + Pear keybindings (Mod-Z/Mod-Y undo via y-prosemirror's stack;
 *     Mod-B/I/U/Shift-S inline mark toggles; Mod-` inline code; Shift-Enter
 *     hard-break)
 *
 * Mounted by `<RichText>` only when the block is in the viewport (or has
 * focus) per § Performance — Viewport-aware editor mounting. The static
 * HTML path covers off-screen blocks.
 *
 * AI-origin updates (sprint 7 — AI authoring surface) will land with
 * `origin === "ai"` and behave identically to remote-origin from this
 * view's perspective.
 */
export function RichTextEditor({
  doc,
  componentId,
  placeholder,
  onFocus,
  onBlur,
}: {
  doc: Y.Doc;
  componentId: bigint;
  placeholder?: string;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const idbRef = useRef<IndexeddbPersistence | null>(null);
  const saveComponentYjsState = useSaveComponentYjsState();
  const { idbNamespace } = useWorkspace();
  // Exposed to the floating toolbar so it can read the editor selection
  // and dispatch toggleMark commands. Lives in state (not ref) because the
  // toolbar is a separate React subtree and needs to re-render when the
  // view becomes available.
  const [view, setView] = useState<EditorView | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const idbName = `pear:${idbNamespace}:component:${componentId}`;
    const idb = new IndexeddbPersistence(idbName, doc);
    idbRef.current = idb;

    const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_KEY);

    // Local user gestures land with `null` origin in the Yjs convention —
    // prosemirror's ySyncPlugin uses that for typed input. `yUndoPlugin`
    // builds its own Set internally combining its own plugin key + this
    // array; we hand it the additional local-origin tag so only local
    // edits land on the undo stack, and remote/AI updates skip it.
    // See § Cross-block undo / redo — Origin filtering.
    const trackedOrigins: unknown[] = [null];

    const state = EditorState.create({
      schema: richTextSchema,
      plugins: [
        ySyncPlugin(fragment),
        yUndoPlugin({ trackedOrigins }),
        keymap({
          "Mod-z": yUndo,
          "Mod-y": yRedo,
          "Mod-Shift-z": yRedo,
          "Mod-b": toggleMark(richTextSchema.marks.bold),
          "Mod-i": toggleMark(richTextSchema.marks.italic),
          "Mod-u": toggleMark(richTextSchema.marks.underline),
          "Mod-Shift-s": toggleMark(richTextSchema.marks.strike),
          "Mod-`": toggleMark(richTextSchema.marks.code),
          "Shift-Enter": chainCommands(exitCode, (state, dispatch) => {
            if (dispatch) {
              dispatch(
                state.tr
                  .replaceSelectionWith(richTextSchema.nodes.hard_break.create())
                  .scrollIntoView(),
              );
            }
            return true;
          }),
        }),
        keymap(baseKeymap),
      ],
    });

    const editorView = new EditorView(hostRef.current, {
      state,
      attributes: {
        class:
          "outline-none min-h-[1.5em] " +
          (placeholder ? `[&:empty]:before:content-[attr(data-placeholder)] ` : ""),
        "data-placeholder": placeholder ?? "",
      },
      handleDOMEvents: {
        focus: () => {
          onFocus?.();
          return false;
        },
        blur: () => {
          onBlur?.();
          return false;
        },
      },
    });
    viewRef.current = editorView;
    setView(editorView);

    // Save cycle. Only flush when there have been local-origin updates since
    // the last flush; ignore remote/AI updates (they were authored elsewhere
    // and saved by that author).
    let dirty = false;
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      if (origin === "remote" || origin === "ai") return;
      dirty = true;
    };
    doc.on("update", onUpdate);
    const flush = () => {
      if (!dirty) return;
      dirty = false;
      try {
        saveComponentYjsState({
          componentId,
          data: Y.encodeStateAsUpdate(doc),
        });
      } catch (err) {
        if (typeof console !== "undefined") {
          console.warn(
            `[RichTextEditor] save failed for component ${componentId}:`,
            err,
          );
        }
      }
    };
    const interval = window.setInterval(flush, SAVE_INTERVAL_MS);
    const onBeforeUnload = () => flush();
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      doc.off("update", onUpdate);
      window.clearInterval(interval);
      window.removeEventListener("beforeunload", onBeforeUnload);
      flush();
      editorView.destroy();
      viewRef.current = null;
      setView(null);
      idb.destroy();
      idbRef.current = null;
    };
    // We intentionally rebuild the view if the doc identity changes — that
    // signals a different RichText node, not an update to the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, componentId, idbNamespace]);

  return (
    <>
      <div
        ref={hostRef}
        className="my-2 text-neutral-900 dark:text-neutral-100 leading-relaxed
                   [&_.ProseMirror]:outline-none
                   [&_.ProseMirror_p]:my-2
                   [&_.ProseMirror_a]:underline
                   [&_.ProseMirror_code]:rounded
                   [&_.ProseMirror_code]:bg-neutral-100
                   dark:[&_.ProseMirror_code]:bg-neutral-800
                   [&_.ProseMirror_code]:px-1
                   [&_.ProseMirror_code]:py-0.5
                   [&_.ProseMirror_strong]:font-semibold
                   [&_.ProseMirror_em]:italic
                   [&_.ProseMirror_u]:underline
                   [&_.ProseMirror_s]:line-through"
      />
      <FormattingToolbar view={view} />
    </>
  );
}
