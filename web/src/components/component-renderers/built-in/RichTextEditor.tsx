"use client";

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { EditorState, Selection } from "prosemirror-state";
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
import { useSurfaceFocus } from "@/src/hooks/useSurfaceFocus";
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
  shouldClaimFocus,
  onFocus,
  onBlur,
  onInsertSiblingBelow,
  onDeleteSelf,
  onSlashTrigger,
}: {
  doc: Y.Doc;
  componentId: bigint;
  placeholder?: string;
  /**
   * Called once on editor mount to ask the surface autofocus
   * coordinator whether this newly-mounted block was the target of a
   * just-dispatched insert. Returns true exactly once per armed
   * insert; this editor's mount effect then focuses itself.
   */
  shouldClaimFocus?: () => boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  /**
   * Called when the user presses Enter at the end of the doc. Caller is
   * expected to dispatch `insert_component` for a new RichText sibling.
   * If absent, Enter falls through to ProseMirror's default `splitBlock`
   * (creates a new paragraph within the same RichText).
   */
  onInsertSiblingBelow?: () => void;
  /**
   * Called when the user presses Backspace at the start of an empty doc.
   * Caller is expected to dispatch `delete_component` for this node. If
   * absent (e.g. this is the only block on the surface), Backspace
   * falls through to its default behaviour (which is a no-op at pos 1
   * of an empty paragraph).
   */
  onDeleteSelf?: () => void;
  /**
   * Called when the user types `/` at the start of an empty doc. Caller
   * receives the cursor's screen rect (for popover positioning) and is
   * expected to render the `<SlashMenu>`. The `/` keystroke is
   * suppressed when this fires — it does not enter the doc.
   */
  onSlashTrigger?: (cursorRect: DOMRect) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const idbRef = useRef<IndexeddbPersistence | null>(null);
  const saveComponentYjsState = useSaveComponentYjsState();
  const focus = useSurfaceFocus();
  const { idbNamespace } = useWorkspace();
  // Exposed to the floating toolbar so it can read the editor selection
  // and dispatch toggleMark commands. Lives in state (not ref) because the
  // toolbar is a separate React subtree and needs to re-render when the
  // view becomes available.
  const [view, setView] = useState<EditorView | null>(null);

  // Latest callback refs — the prosemirror keymap closes over the *first*
  // render's values, so we route through refs that we update on every
  // render. Keeps closure-captured Enter/Backspace logic in sync with
  // parent-component state without forcing the editor to re-mount.
  const onInsertSiblingBelowRef = useRef(onInsertSiblingBelow);
  const onDeleteSelfRef = useRef(onDeleteSelf);
  const onSlashTriggerRef = useRef(onSlashTrigger);
  const shouldClaimFocusRef = useRef(shouldClaimFocus);
  onInsertSiblingBelowRef.current = onInsertSiblingBelow;
  onDeleteSelfRef.current = onDeleteSelf;
  onSlashTriggerRef.current = onSlashTrigger;
  shouldClaimFocusRef.current = shouldClaimFocus;

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
          "Shift-Enter": chainCommands(exitCode, (s, dispatch) => {
            if (dispatch) {
              dispatch(
                s.tr
                  .replaceSelectionWith(richTextSchema.nodes.hard_break.create())
                  .scrollIntoView(),
              );
            }
            return true;
          }),
          // Block-boundary semantics — § Block chrome / Enter & Backspace.
          // Enter at the very end of the doc inserts a new RichText sibling
          // below via the substrate reducer (escapes this block). Anywhere
          // else, Enter falls through to baseKeymap's `splitBlock` which
          // creates a new paragraph within this same RichText.
          Enter: (s) => {
            if (!s.selection.empty) return false;
            const atEnd = s.selection.$head.pos === s.doc.content.size - 1;
            if (!atEnd) return false;
            if (!onInsertSiblingBelowRef.current) return false;
            onInsertSiblingBelowRef.current();
            return true;
          },
          // Backspace at the start of an empty doc deletes this RichText
          // (caller decides whether to allow it — e.g. forbids when this
          // is the only block on the surface). Backspace at start of a
          // non-empty doc would ideally merge with the previous RichText;
          // that requires Yjs cross-doc content copy and lands in a later
          // sprint. Until then, non-empty-start Backspace is a no-op.
          Backspace: (s) => {
            if (!s.selection.empty) return false;
            const atStart = s.selection.$head.pos === 1;
            if (!atStart) return false;
            const isEmpty = s.doc.textContent.length === 0;
            if (!isEmpty) return false;
            if (!onDeleteSelfRef.current) return false;
            onDeleteSelfRef.current();
            return true;
          },
          // Slash menu trigger — only fires at the start of an empty
          // doc, matching the ADR § Block chrome / Slash menu contract.
          // Suppresses the "/" keystroke so it doesn't litter the doc
          // when the user dismisses the menu. Editor.coordsAtPos gives
          // us a viewport-relative cursor rect for popover anchoring.
          "/": (s, _dispatch, view) => {
            if (!view) return false;
            if (!s.selection.empty) return false;
            if (s.doc.textContent.length !== 0) return false;
            if (s.selection.$head.pos !== 1) return false;
            const trigger = onSlashTriggerRef.current;
            if (!trigger) return false;
            const coords = view.coordsAtPos(s.selection.from);
            const rect = new DOMRect(
              coords.left,
              coords.top,
              0,
              coords.bottom - coords.top,
            );
            trigger(rect);
            return true;
          },
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

    // Imperative focus handler — registered with the surface focus
    // coordinator so Backspace-into-previous / "Turn into…" / etc.
    // can imperatively focus this editor + place the caret at end.
    // Identical semantics to the claim-on-mount autofocus path
    // below, so users land in the same state regardless of which
    // gesture pulled them here.
    const focusSelf = () => {
      try {
        editorView.focus();
        const tr = editorView.state.tr.setSelection(
          Selection.atEnd(editorView.state.doc),
        );
        editorView.dispatch(tr);
      } catch (err) {
        if (typeof console !== "undefined") {
          console.warn(
            `[RichTextEditor] focusSelf failed for component ${componentId}:`,
            err,
          );
        }
      }
    };
    const unregister = focus.registerFocusable(componentId, focusSelf);

    // Autofocus claim — if the surface coordinator has armed this
    // block as the focus target (Enter / slash-menu select / chrome
    // `+` just dispatched the insert that produced us, OR a sibling's
    // Backspace just requested focus on us before we were mounted),
    // run the same focusSelf above.
    if (shouldClaimFocusRef.current?.()) {
      focusSelf();
    }

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
      unregister();
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
