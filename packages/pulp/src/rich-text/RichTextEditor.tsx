"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
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
  ySyncPluginKey,
} from "y-prosemirror";
import { UndoManager } from "yjs";
import {
  richTextSchema,
  PROSEMIRROR_FRAGMENT_KEY,
} from "./richTextSchema";
import { usePulp } from "../context/PulpProvider";
import { useSurfaceFocus } from "../focus/SurfaceFocusProvider";
import {
  applyEditorFocus,
  editorHasFocus,
  type FocusPlacement,
} from "../focus/SurfaceFocusCoordinator";
import { focusDebug, idStr } from "../focus/focusDebug";
import { isAtDocEnd, isAtDocStart } from "../navigation/blockNavigation";
import { useSurfaceUndo } from "../undo/SurfaceUndoProvider";
import { FormattingToolbar, type BlockToolbarActions } from "./FormattingToolbar";

/** Cadence — see `docs/PEAR_WEB_RENDERER.md` § Editor stack — Save cycle. */
const SAVE_INTERVAL_MS = 30_000;

const EDITOR_PROSE_DEFAULT =
  "my-2 text-neutral-900 dark:text-neutral-100 leading-relaxed [&_.ProseMirror]:outline-none [&_.ProseMirror_p]:my-2 [&_.ProseMirror_a]:underline [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:bg-neutral-100 dark:[&_.ProseMirror_code]:bg-neutral-800 [&_.ProseMirror_code]:px-1 [&_.ProseMirror_code]:py-0.5 [&_.ProseMirror_strong]:font-semibold [&_.ProseMirror_em]:italic [&_.ProseMirror_u]:underline [&_.ProseMirror_s]:line-through";

const EDITOR_PROSE_LIST_ITEM =
  "my-0 text-neutral-900 dark:text-neutral-100 leading-normal [&_.ProseMirror]:outline-none [&_.ProseMirror_p]:my-0 [&_.ProseMirror_a]:underline [&_.ProseMirror_code]:rounded [&_.ProseMirror_code]:bg-neutral-100 dark:[&_.ProseMirror_code]:bg-neutral-800 [&_.ProseMirror_code]:px-1 [&_.ProseMirror_code]:py-0.5 [&_.ProseMirror_strong]:font-semibold [&_.ProseMirror_em]:italic [&_.ProseMirror_u]:underline [&_.ProseMirror_s]:line-through";

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
  textDensity = "default",
  shouldClaimFocus,
  onFocus,
  onBlur,
  onSplit,
  onDeleteSelf,
  onMergeWithPrev,
  onSlashTrigger,
  suppressSaveRef,
  onNavigatePrev,
  onNavigateNext,
  onIndent,
  onOutdent,
  bindFocus,
  blockActions,
}: {
  doc: Y.Doc;
  componentId: bigint;
  placeholder?: string;
  /** Compact prose for list-item rows (no paragraph margins). */
  textDensity?: "default" | "listItem";
  /**
   * Called once on editor mount to claim autofocus after an insert.
   * Returns caret placement when this block was the insert target.
   */
  shouldClaimFocus?: () => FocusPlacement | null;
  onFocus?: () => void;
  onBlur?: () => void;
  /**
   * Called on **Enter** anywhere in the doc — at end, in middle, at
   * start. Caller is expected to split the doc at the cursor (cut
   * suffix into a new sibling `RichText`) and arm autofocus on the
   * new block. Receives the live view so the caller can read the
   * selection and dispatch transactions to truncate this doc. Returns
   * true if the gesture was claimed; false falls through to default
   * `splitBlock` (creates a new paragraph within this same RichText).
   */
  onSplit?: (view: EditorView) => boolean;
  /**
   * Called when the user presses Backspace at the start of an empty doc.
   * Caller is expected to dispatch `delete_component` for this node. If
   * absent (e.g. this is the only block on the surface), Backspace
   * falls through to its default behaviour (which is a no-op at pos 1
   * of an empty paragraph).
   */
  onDeleteSelf?: () => void;
  /**
   * Called on Backspace at the start of a **non-empty** doc. Caller is
   * expected to merge this block's content into the previous sibling's
   * RichText (Notion-style join) and delete this block. Receives the
   * live view so the caller can read this doc's content. Returns true
   * if the gesture was claimed; false falls through to default
   * Backspace (deletes one character).
   */
  onMergeWithPrev?: (view: EditorView) => boolean;
  /**
   * Called when the user types `/` at the start of an empty doc. Caller
   * receives the cursor's screen rect (for popover positioning) and is
   * expected to render the `<SlashMenu>`. The `/` keystroke is
   * suppressed when this fires — it does not enter the doc.
   */
  onSlashTrigger?: (cursorRect: DOMRect) => void;
  /**
   * When true, skip Yjs persistence — the block is being soft-deleted and
   * `save_component_yjs_state` would reject a deleted node.
   */
  suppressSaveRef?: RefObject<boolean>;
  /** ArrowUp at doc start — focus previous sibling (caret at end). */
  onNavigatePrev?: () => boolean;
  /** ArrowDown at doc end — focus next sibling (caret at start). */
  onNavigateNext?: () => boolean;
  /** Tab — nest block under previous sibling when supported. */
  onIndent?: () => boolean;
  /** Shift+Tab — unnest block to grandparent. */
  onOutdent?: () => boolean;
  /**
   * Parent registers the surface focus coordinator against this editor's
   * applyFocus fn — keeps static→live transitions able to reach a live view.
   */
  bindFocus?: (applyFocus: (placement: FocusPlacement) => void) => () => void;
  /** Block-level toolbar controls (type dropdown, nest/unnest). */
  blockActions?: BlockToolbarActions;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const idbRef = useRef<IndexeddbPersistence | null>(null);
  const { saveYjsState, config, tree } = usePulp();
  const focus = useSurfaceFocus();
  const { registerYjsUndoManager } = useSurfaceUndo();
  const idbPrefix = config.idbPrefix;
  const treeRef = useRef(tree);
  treeRef.current = tree;
  // Exposed to the floating toolbar so it can read the editor selection
  // and dispatch toggleMark commands. Lives in state (not ref) because the
  // toolbar is a separate React subtree and needs to re-render when the
  // view becomes available.
  const [view, setView] = useState<EditorView | null>(null);
  const [linkRequest, setLinkRequest] = useState(0);

  // Latest callback refs — the prosemirror keymap closes over the *first*
  // render's values, so we route through refs that we update on every
  // render. Keeps closure-captured Enter/Backspace logic in sync with
  // parent-component state without forcing the editor to re-mount.
  const onSplitRef = useRef(onSplit);
  const onDeleteSelfRef = useRef(onDeleteSelf);
  const onMergeWithPrevRef = useRef(onMergeWithPrev);
  const onSlashTriggerRef = useRef(onSlashTrigger);
  const onNavigatePrevRef = useRef(onNavigatePrev);
  const onNavigateNextRef = useRef(onNavigateNext);
  const onIndentRef = useRef(onIndent);
  const onOutdentRef = useRef(onOutdent);
  const shouldClaimFocusRef = useRef(shouldClaimFocus);
  const bindFocusRef = useRef(bindFocus);
  onSplitRef.current = onSplit;
  onDeleteSelfRef.current = onDeleteSelf;
  onMergeWithPrevRef.current = onMergeWithPrev;
  onSlashTriggerRef.current = onSlashTrigger;
  onNavigatePrevRef.current = onNavigatePrev;
  onNavigateNextRef.current = onNavigateNext;
  onIndentRef.current = onIndent;
  onOutdentRef.current = onOutdent;
  shouldClaimFocusRef.current = shouldClaimFocus;
  bindFocusRef.current = bindFocus;

  useLayoutEffect(() => {
    if (!hostRef.current) return;

    const idbName = `${idbPrefix}:component:${componentId}`;
    const idb = new IndexeddbPersistence(idbName, doc);
    idbRef.current = idb;

    const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_KEY);

    const undoManager = new UndoManager(fragment, {
      trackedOrigins: new Set([ySyncPluginKey, null]),
    });

    const state = EditorState.create({
      schema: richTextSchema,
      plugins: [
        ySyncPlugin(fragment),
        yUndoPlugin({ undoManager }),
        keymap({
          // Mod-Z / Mod-Shift-Z routed at surface level — § Cross-block undo.
          "Mod-b": toggleMark(richTextSchema.marks.bold),
          "Mod-i": toggleMark(richTextSchema.marks.italic),
          "Mod-u": toggleMark(richTextSchema.marks.underline),
          "Mod-Shift-s": toggleMark(richTextSchema.marks.strike),
          "Mod-`": toggleMark(richTextSchema.marks.code),
          "Mod-k": (s) => {
            if (s.selection.empty) return false;
            setLinkRequest((n) => n + 1);
            return true;
          },
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
          //
          // Enter unconditionally splits this RichText into two: the
          // prefix stays here, the suffix becomes a new RichText
          // sibling below. The "at-end" special-case from sprint 3a is
          // subsumed by this — at-end is just "suffix is empty". The
          // suffix Y.Doc is built by the caller and handed off via the
          // surface focus coordinator's initialDoc mechanism. Shift-
          // Enter is intercepted earlier as hard_break and never
          // reaches this handler.
          Enter: (s) => {
            if (!s.selection.empty) return false;
            const view = viewRef.current;
            if (!view) return false;
            const handler = onSplitRef.current;
            if (!handler) return false;
            focusDebug("Enter key → onSplit", { componentId: idStr(componentId) });
            return handler(view);
          },
          // Backspace at start of doc. Two paths:
          //   • Doc empty → delete this block (caller decides whether
          //     to allow it — e.g. forbids when this is the only block
          //     on the surface).
          //   • Doc non-empty → merge: append this doc's content into
          //     the previous sibling's RichText, then delete this
          //     block (Notion-style join). Caller handles the cross-
          //     doc content extraction.
          // Backspace anywhere else falls through to the default
          // (delete one character).
          Backspace: (s) => {
            if (!s.selection.empty) return false;
            const atStart = s.selection.$head.pos === 1;
            if (!atStart) return false;
            const view = viewRef.current;
            if (!view) return false;
            const isEmpty = s.doc.textContent.length === 0;
            if (isEmpty) {
              if (!onDeleteSelfRef.current) return false;
              onDeleteSelfRef.current();
              return true;
            }
            const merge = onMergeWithPrevRef.current;
            if (!merge) return false;
            return merge(view);
          },
          // Cross-block navigation — Notion-style: leave the block when
          // the caret is collapsed at the first/last editable position.
          ArrowUp: (s) => {
            if (!s.selection.empty) return false;
            const docEnd = s.doc.content.size;
            if (!isAtDocStart(docEnd, s.selection.head)) return false;
            const nav = onNavigatePrevRef.current;
            return nav?.() ?? false;
          },
          ArrowDown: (s) => {
            if (!s.selection.empty) return false;
            const docEnd = s.doc.content.size;
            if (!isAtDocEnd(docEnd, s.selection.head)) return false;
            const nav = onNavigateNextRef.current;
            return nav?.() ?? false;
          },
          Tab: () => {
            const handler = onIndentRef.current;
            if (!handler) return false;
            return handler();
          },
          "Shift-Tab": () => {
            const handler = onOutdentRef.current;
            if (!handler) return false;
            return handler();
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
        click: (_view, event) => {
          const anchor = (event.target as Element | null)?.closest?.("a[href]");
          if (!(anchor instanceof HTMLAnchorElement)) return false;
          const href = anchor.getAttribute("href");
          if (!href) return false;

          const mouse = event as MouseEvent;
          if (!mouse.metaKey && !mouse.ctrlKey) {
            event.preventDefault();
            return true;
          }

          event.preventDefault();
          navigateToHref(href);
          return true;
        },
        focus: () => {
          onFocus?.();
          // Do not ack here — focus fires synchronously during applyEditorFocus
          // and would clear the armed placement before handoff completes.
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
    const focusSelf = (placement: FocusPlacement = "end") => {
      try {
        applyEditorFocus(editorView, placement);
      } catch (err) {
        if (typeof console !== "undefined") {
          console.warn(
            `[RichTextEditor] focusSelf failed for component ${componentId}:`,
            err,
          );
        }
      }
    };
    const unregisterBindFocus = bindFocusRef.current?.(focusSelf);
    // Also register the live EditorView so sibling Backspace-merge
    // gestures can reach in and append content.
    const unregisterEditor = focus.registerEditor(componentId, editorView);
    const unregisterUndo = registerYjsUndoManager(componentId, undoManager);

    const tryClaimAutofocus = () => {
      const claimPlacement = shouldClaimFocusRef.current?.();
      if (!claimPlacement) return false;
      focusDebug("tryClaimAutofocus", {
        componentId: idStr(componentId),
        placement: claimPlacement,
      });
      focusSelf(claimPlacement);
      const hasFocus = editorHasFocus(editorView);
      focusDebug("tryClaimAutofocus: result", {
        componentId: idStr(componentId),
        hasFocus,
      });
      if (!hasFocus) return false;
      focusDebug("tryClaimAutofocus: ack", { componentId: idStr(componentId) });
      focus.ackFocus(componentId);
      return true;
    };

    const scheduleAutofocusRetries = () => {
      const retryDelaysMs = [0, 16, 50, 100, 200, 400, 700, 1000, 1500];
      for (const delayMs of retryDelaysMs) {
        focusRetryTimeouts.push(
          window.setTimeout(() => {
            if (viewRef.current !== editorView) return;
            tryClaimAutofocus();
          }, delayMs),
        );
      }
    };

    const focusRetryTimeouts: number[] = [];
    // Double rAF so we run after Strict Mode remount + parent registerFocusable.
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (viewRef.current !== editorView) return;
          if (!tryClaimAutofocus()) scheduleAutofocusRetries();
        });
      });
    } else {
      focusRetryTimeouts.push(
        window.setTimeout(() => {
          if (viewRef.current !== editorView) return;
          if (!tryClaimAutofocus()) scheduleAutofocusRetries();
        }, 0),
      );
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
      if (suppressSaveRef?.current) return;
      if (!treeRef.current.byId.has(componentId)) return;
      if (!dirty) return;
      dirty = false;
      try {
        void Promise.resolve(
          saveYjsState({
            componentId,
            data: Y.encodeStateAsUpdate(doc),
          }),
        ).catch(() => {
          // Block may have been soft-deleted between flush scheduling and
          // the reducer round-trip — safe to ignore.
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
      for (const id of focusRetryTimeouts) window.clearTimeout(id);
      unregisterBindFocus?.();
      unregisterEditor();
      unregisterUndo();
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
  }, [doc, componentId, idbPrefix]);

  const proseClass =
    textDensity === "listItem" ? EDITOR_PROSE_LIST_ITEM : EDITOR_PROSE_DEFAULT;

  return (
    <>
      <div ref={hostRef} className={proseClass} />
      <FormattingToolbar view={view} linkRequest={linkRequest} blockActions={blockActions} />
    </>
  );
}

function navigateToHref(href: string): void {
  if (href.startsWith("/") || href.startsWith("#")) {
    window.location.assign(href);
    return;
  }
  try {
    const url = new URL(href, window.location.href);
    if (url.origin === window.location.origin) {
      window.location.assign(url.href);
    } else {
      window.open(url.href, "_blank", "noopener,noreferrer");
    }
  } catch {
    window.location.assign(href);
  }
}
