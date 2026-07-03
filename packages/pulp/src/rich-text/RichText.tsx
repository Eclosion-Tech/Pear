"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type CSSProperties,
} from "react";
import * as Y from "yjs";
import type { EditorView } from "prosemirror-view";
import { yDocToHtml } from "./yjsToHtml";
import { usePulp } from "../context/PulpProvider";
import { useSurfaceFocus } from "../focus/SurfaceFocusProvider";
import { useSurfaceSelectionOptional } from "../selection/SurfaceSelectionProvider";
import { splitEditorAtCaret } from "./splitEditorAtCaret";
import type { BlockRendererProps } from "../registry";
import type { BlockId } from "../types";
import { RichTextEditor } from "./RichTextEditor";
import {
  SPRINT_3B_SLASH_ITEMS,
  filterSlashItems,
  type SlashMenuItem,
} from "../SlashMenu";
import { InlineSlashMenu } from "./InlineSlashMenu";
import { closeSlashSession } from "./slashMenuPlugin";
import { parseClipboardToBlocks } from "./pasteToBlocks";
import { turnIntoToolbarItems } from "../toolbarTurnIntoItems";
import { buildMarkdownShortcuts } from "./markdownInputRules";
import { knownSiblingIdsForParent, siblingsForParent, idsMatch } from "../focus/insertFocusHelpers";
import type { FocusPlacement } from "../focus/SurfaceFocusCoordinator";
import { focusDebug, idStr } from "../focus/focusDebug";
import { getDocumentPrevBlock, getDocumentNextBlock } from "../navigation/blockNavigation";
import {
  exitEmptyListItemToRichText,
  unlistToRichText,
  isDocumentListItemType,
  nestBlockUnderPreviousSibling,
  unnestBlock,
  turnIntoBlock,
  canNestBlock,
  canUnnestBlock,
  deleteEmptyBlockAndFocusDocumentPrev,
  mergeBlockIntoDocumentPrev,
  insertBlocksAfter,
} from "../blockActions";

/**
 * Built-in `RichText` component — viewport-aware switcher.
 *
 * Per `docs/PEAR_WEB_RENDERER.md` § Performance — Viewport-aware editor
 * mounting, every `RichText` has two render modes:
 *
 *   1. **Static** — renders the `Y.Doc` through `yDocToHtml`. No
 *      ProseMirror, no event handlers, no IndexedDB handle. Cheap, used
 *      for off-screen blocks.
 *   2. **Live** — full `y-prosemirror` mount via `<RichTextEditor>`. Used
 *      for blocks in the viewport plus a one-viewport preload band.
 *
 * Switch policy:
 *   - `IntersectionObserver` with `rootMargin: 100%` flips to live on
 *     intersection; flips back to static when the block exits the band
 *     **unless** the block currently holds focus (focus-preserving — a
 *     focused block stays live even if the user scrolls it off-screen).
 *
 * The `Y.Doc` is stable across mode switches. Remote-origin Yjs deltas
 * from `ComponentYjsState` row updates are applied to the same doc; both
 * the static HTML render and the live editor see them. AI-origin deltas
 * (sprint 7) will route through the same path.
 *
 * Prop schema (`prop_schemas::RICH_TEXT` in components.rs):
 *   { placeholder?: string,
 *     maxLength?: number,           // editor-level (sprint 2+ advisory)
 *     markWhitelist?: string[] }    // editor-level (sprint 2+ advisory)
 */
type RichTextProps = {
  placeholder?: string;
  maxLength?: number;
  markWhitelist?: string[];
};

export type RichTextTextDensity = "default" | "listItem";

const STATIC_PROSE_DEFAULT =
  "my-2 text-neutral-900 dark:text-neutral-100 leading-relaxed [&_p]:my-2 [&_a]:underline [&_code]:rounded [&_code]:bg-neutral-100 [&_code]:dark:bg-neutral-800 [&_code]:px-1 [&_code]:py-0.5 [&_strong]:font-semibold [&_em]:italic [&_u]:underline [&_s]:line-through";

const STATIC_PROSE_LIST_ITEM =
  "my-0 text-neutral-900 dark:text-neutral-100 leading-normal [&_p]:my-0 [&_a]:underline [&_code]:rounded [&_code]:bg-neutral-100 [&_code]:dark:bg-neutral-800 [&_code]:px-1 [&_code]:py-0.5 [&_strong]:font-semibold [&_em]:italic [&_u]:underline [&_s]:line-through";

/**
 * Public `RichText` renderer — a thin dispatcher. In read-only mode
 * (`config.readOnly`, set by `<BlockView>`) it renders the static HTML body
 * with no ProseMirror / IndexedDB / focus / observer machinery; otherwise the
 * full viewport-aware editable renderer.
 */
export function RichTextRenderer(
  props: BlockRendererProps & { textDensity?: RichTextTextDensity },
) {
  const { config } = usePulp();
  if (config.readOnly) return <StaticRichText {...props} />;
  return <EditableRichText {...props} />;
}

/**
 * Read-only RichText — builds the HTML once from the node's Yjs blob and
 * renders it statically. No editor, no mutations, no IndexedDB, no focus or
 * intersection wiring. Safe outside the editing contexts.
 */
function StaticRichText({
  node,
  tree,
  textDensity = "default",
}: BlockRendererProps & { textDensity?: RichTextTextDensity }) {
  const props = useMemo<RichTextProps>(() => safeParse(node.props), [node.props]);
  const state = tree.yjs.get(node.id);
  const html = useMemo(() => {
    if (!state?.data || state.data.byteLength === 0) return "";
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state.data, "remote");
      return yDocToHtml(doc);
    } catch {
      return "";
    } finally {
      doc.destroy();
    }
  }, [state?.data]);
  return (
    <StaticBody
      html={html}
      placeholder={props.placeholder ?? ""}
      textDensity={textDensity}
    />
  );
}

function EditableRichText({
  node,
  tree,
  textDensity = "default",
}: BlockRendererProps & { textDensity?: RichTextTextDensity }) {
  const props = useMemo<RichTextProps>(() => safeParse(node.props), [node.props]);
  const state = tree.yjs.get(node.id);
  const { insertBlock, deleteBlock, moveBlock, saveYjsState, config, updateBlockProps } = usePulp();
  const focus = useSurfaceFocus();
  const selection = useSurfaceSelectionOptional();
  /** Set before intentional soft-delete so unmount flush skips save. */
  const suppressSaveRef = useRef(false);
  const editorApplyFocusRef = useRef<((placement: FocusPlacement) => void) | null>(
    null,
  );
  const pendingFocusRef = useRef<FocusPlacement | null>(null);
  /** Set in `onSplit`; cleared once the new sibling receives focus. */
  const splitHandoffRef = useRef<{
    parentId: BlockId;
    afterId: BlockId;
    knownIds: Set<string>;
  } | null>(null);
  const splitHandoffWaitLoggedRef = useRef(false);

  const removeSelf = () => {
    suppressSaveRef.current = true;
    deleteBlock({ componentId: node.id });
  };

  const onNavigatePrev = useCallback((goalX?: number): boolean => {
    const prev = getDocumentPrevBlock(tree, node.id);
    if (!prev) return false;
    focus.requestFocus(prev.id, "end", goalX);
    return true;
  }, [tree, node.id, focus]);

  const onNavigateNext = useCallback((goalX?: number): boolean => {
    const next = getDocumentNextBlock(tree, node.id);
    if (!next) return false;
    focus.requestFocus(next.id, "start", goalX);
    return true;
  }, [tree, node.id, focus]);

  const bindFocus = useCallback(
    (applyFocus: (placement: FocusPlacement) => void) => {
      editorApplyFocusRef.current = applyFocus;
      if (pendingFocusRef.current) {
        applyFocus(pendingFocusRef.current);
        pendingFocusRef.current = null;
      }
      return () => {
        editorApplyFocusRef.current = null;
      };
    },
    [],
  );

  const claimInsertFocus = useCallback((): FocusPlacement | null => {
    return (
      focus.matchPendingInsert(node.id, tree, (componentId, data) =>
        saveYjsState({ componentId, data }),
      ) ?? focus.claimFocus(node.id)
    );
  }, [focus, node.id, tree, saveYjsState]);

  // Block-boundary structural callbacks — § Block chrome / Enter & Backspace.
  //
  // Split on Enter (unified for at-end, in-middle, at-start). The user's
  // cursor partitions this doc into prefix (stays here) and suffix
  // (becomes a new RichText sibling immediately below). The suffix
  // Y.Doc is built locally via `prosemirrorToYDoc` and handed to the
  // surface focus coordinator, which both stashes it for the mounting
  // RichText and persists it to the server. At-end is the degenerate
  // case where the suffix is an empty paragraph.
  //
  // **Position math.** `splitBlock` mutates the current doc to insert
  // a paragraph break at the cursor. After that, the cursor lands at
  // the start of the new (second) paragraph's content, which is doc-
  // level position `boundary + 1` where `boundary` is the opening tag
  // of that new paragraph at the doc level. We capture `boundary`,
  // `cut` from there to end to build the suffix node, and `delete`
  // from there to end to truncate this doc. Both transforms operate
  // on the post-splitBlock state.
  const onSplit = (view: EditorView): boolean => {
    if (node.parentId == null) return false;
    if (focus.isAwaitingInsert()) {
      focusDebug("onSplit: swallow (awaiting insert)", { nodeId: idStr(node.id) });
      return true;
    }

    if (
      view.state.doc.textContent.length === 0 &&
      isDocumentListItemType(node.componentType)
    ) {
      focusDebug("onSplit: exit empty list item → RichText", {
        nodeId: idStr(node.id),
        componentType: node.componentType,
      });
      suppressSaveRef.current = true;
      return exitEmptyListItemToRichText(
        node,
        tree,
        { insertBlock, deleteBlock, moveBlock },
        focus,
      );
    }

    // Split the doc at the caret — prefix stays here, suffix seeds the new
    // sibling (marks carried). Handles start / middle / end uniformly; at-end
    // is just an empty suffix. Null → splitBlock couldn't apply, fall through
    // to default Enter so the user isn't stuck.
    const initialDoc = splitEditorAtCaret(view);
    if (!initialDoc) return false;

    focus.armForInsert(node.parentId, node.id, {
      initialDoc,
      focusAt: "start",
      knownSiblingIds: knownSiblingIdsForParent(tree, node.parentId),
    });
    splitHandoffRef.current = {
      parentId: node.parentId,
      afterId: node.id,
      knownIds: new Set(
        knownSiblingIdsForParent(tree, node.parentId).map((id) => id.toString()),
      ),
    };
    splitHandoffWaitLoggedRef.current = false;
    focusDebug("onSplit: insertBlock", {
      sourceId: idStr(node.id),
      parentId: idStr(node.parentId),
      knownSiblingCount: splitHandoffRef.current.knownIds.size,
    });
    insertBlock({
      parentId: node.parentId,
      componentType: node.componentType,
      propsJson: JSON.stringify(splitPropsFor(node.componentType, node.props)),
      afterSiblingId: node.id,
    });
    return true;
  };

  const siblings = node.parentId != null ? tree.byParent.get(node.parentId) ?? [] : [];
  const canDelete = siblings.length > 1;

  const onIndent = useCallback((): boolean => {
    return nestBlockUnderPreviousSibling(
      node,
      tree,
      { moveBlock },
      focus,
    );
  }, [node, tree, moveBlock, focus]);

  const onOutdent = useCallback((): boolean => {
    return unnestBlock(node, tree, { moveBlock }, focus);
  }, [node, tree, moveBlock, focus]);

  const turnIntoItems = useMemo(
    () => turnIntoToolbarItems(config.slashItems ?? SPRINT_3B_SLASH_ITEMS, tree.defs),
    [config.slashItems, tree.defs],
  );

  // Markdown prefix shortcuts (`- `, `# `, `[] `, …) — derived from the same
  // curated turn-into set so unregistered types are skipped automatically.
  const markdownShortcuts = useMemo(
    () => buildMarkdownShortcuts(turnIntoItems),
    [turnIntoItems],
  );
  const onMarkdownShortcut = useCallback(
    (item: SlashMenuItem) => {
      turnIntoBlock(
        node,
        tree,
        item,
        { insertBlock, deleteBlock, moveBlock, updateBlockProps, saveYjsState },
        focus,
      );
    },
    [
      node,
      tree,
      insertBlock,
      deleteBlock,
      moveBlock,
      updateBlockProps,
      saveYjsState,
      focus,
    ],
  );

  // Multi-block paste — split a markdown / multi-paragraph / HTML clipboard
  // into sibling blocks below this one. Single-block pastes fall through to
  // ProseMirror's default inline paste (which preserves marks in place).
  const onPaste = (
    data: { text: string; html: string },
    view: EditorView,
  ): boolean => {
    if (node.parentId == null) return false;
    const availableTypes = new Set(tree.defs.keys());
    const blocks = parseClipboardToBlocks(data, {
      shortcuts: markdownShortcuts,
      availableTypes,
    });
    if (blocks.length < 2) return false;

    const hostEmpty = view.state.doc.textContent.trim().length === 0;
    insertBlocksAfter(node, blocks, { insertBlock }, focus, tree);

    // Pasting into an empty line with siblings: drop the empty host so the
    // pasted blocks take its place (mirrors the slash-insert behavior).
    const siblingCount = tree.byParent.get(node.parentId)?.length ?? 0;
    if (hostEmpty && siblingCount > 1) removeSelf();
    return true;
  };

  // Escape with no slash menu open — promote to whole-block selection and
  // blur the editor so surface-level keys (Backspace/Escape) take over.
  const onEscape = (): boolean => {
    if (!selection) return false;
    selection.controller.selectOnly(node.id);
    focus.getEditor(node.id)?.dom.blur();
    return true;
  };

  const blockActions = useMemo(
    () => ({
      componentType: node.componentType,
      propsJson: node.props,
      canNest: canNestBlock(node, tree),
      canUnnest: canUnnestBlock(node, tree),
      turnIntoItems,
      onTurnInto: (item: SlashMenuItem) => {
        turnIntoBlock(
          node,
          tree,
          item,
          { insertBlock, deleteBlock, moveBlock, updateBlockProps, saveYjsState },
          focus,
        );
      },
      onNest: () => {
        onIndent();
      },
      onOutdent: () => {
        onOutdent();
      },
    }),
    [
      node,
      tree,
      turnIntoItems,
      insertBlock,
      deleteBlock,
      moveBlock,
      updateBlockProps,
      saveYjsState,
      focus,
      onIndent,
      onOutdent,
    ],
  );

  // Backspace-on-empty: delete this row and focus the document-order
  // previous block (parent list item when nested — not unnest-to-root).
  const onDeleteSelf = useCallback(() => {
    suppressSaveRef.current = true;
    // List item → un-list to a paragraph first (Notion/BlockNote); a second
    // Backspace on the resulting empty RichText then deletes/merges.
    if (isDocumentListItemType(node.componentType)) {
      unlistToRichText(node, tree, { insertBlock, deleteBlock, moveBlock }, focus);
      return;
    }
    deleteEmptyBlockAndFocusDocumentPrev(node, tree, focus, {
      deleteBlock,
      moveBlock,
    });
  }, [node, tree, focus, deleteBlock, insertBlock, moveBlock]);

  const canBackspaceDeleteEmpty =
    getDocumentPrevBlock(tree, node.id) != null ||
    canDelete ||
    isDocumentListItemType(node.componentType);

  const onMergeWithPrev = (view: EditorView): boolean => {
    suppressSaveRef.current = true;
    // List item → un-list before merging (Notion/BlockNote): the first
    // Backspace at the start of a list row converts it to a paragraph.
    if (isDocumentListItemType(node.componentType)) {
      return unlistToRichText(node, tree, { insertBlock, deleteBlock, moveBlock }, focus);
    }
    return mergeBlockIntoDocumentPrev(
      node,
      view,
      tree,
      focus,
      { saveYjsState, moveBlock },
      removeSelf,
    );
  };

  // Inline slash menu — `/` opens a session in the editor (slashMenuPlugin);
  // the query lives in the doc and filters live. We mirror the session here to
  // render <InlineSlashMenu> and own the commit/dismiss.
  const slashItems = config.slashItems ?? SPRINT_3B_SLASH_ITEMS;
  const [slashSession, setSlashSession] = useState<{
    query: string;
    from: number;
    rect: DOMRect;
  } | null>(null);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const slashFiltered = useMemo(
    () => (slashSession ? filterSlashItems(slashItems, slashSession.query) : []),
    [slashItems, slashSession],
  );

  const dismissSlash = () => {
    const view = focus.getEditor(node.id);
    if (view) closeSlashSession(view);
    setSlashSession(null);
  };

  const navigateSlash = (direction: 1 | -1) => {
    setSlashActiveIndex((i) => {
      const n = slashFiltered.length;
      if (n === 0) return 0;
      return (i + direction + n) % n;
    });
  };

  // Insert the chosen block. When the host RichText is empty after the
  // `/query` is removed, the new block takes its slot (replace, mirroring
  // BlockNote's only-child keep-the-line behavior); otherwise it lands as a
  // sibling immediately below and the host keeps its content.
  const insertChosenBlock = (item: SlashMenuItem, hostNowEmpty: boolean) => {
    if (node.parentId == null) return;
    const parentSiblings = tree.byParent.get(node.parentId) ?? [];
    const propsJson = JSON.stringify(item.defaultProps);

    if (!hostNowEmpty) {
      focus.armForInsert(node.parentId, node.id, {
        knownSiblingIds: knownSiblingIdsForParent(tree, node.parentId),
      });
      insertBlock({
        parentId: node.parentId,
        componentType: item.componentType,
        propsJson,
        afterSiblingId: node.id,
      });
      return;
    }

    const myIdx = parentSiblings.findIndex((s) => s.id === node.id);
    const predecessor = myIdx > 0 ? parentSiblings[myIdx - 1]?.id : undefined;
    focus.armForInsert(node.parentId, predecessor, {
      knownSiblingIds: knownSiblingIdsForParent(tree, node.parentId),
    });
    insertBlock({
      parentId: node.parentId,
      componentType: item.componentType,
      propsJson,
      afterSiblingId: predecessor,
    });
    // With siblings present the new block visually takes this slot; for an
    // only child keep the empty RichText so the Container isn't empty-state.
    if (parentSiblings.length > 1) removeSelf();
  };

  const commitSlash = (explicit?: SlashMenuItem): boolean => {
    if (!slashSession) return false;
    const item = explicit ?? slashFiltered[slashActiveIndex];
    if (!item) {
      dismissSlash();
      return true;
    }
    let hostNowEmpty = true;
    const view = focus.getEditor(node.id);
    if (view) {
      const to = view.state.selection.head;
      const tr = view.state.tr.delete(slashSession.from, to);
      view.dispatch(tr);
      hostNowEmpty = tr.doc.textContent.trim().length === 0;
    }
    setSlashSession(null);
    insertChosenBlock(item, hostNowEmpty);
    return true;
  };

  const onSlashSessionChange = (
    session: { query: string; from: number; rect: DOMRect } | null,
  ) => {
    setSlashSession(session);
    setSlashActiveIndex(0);
  };

  // One stable Y.Doc per RichText instance. Lives as long as this React
  // component is mounted, regardless of whether we're in static or live
  // mode. Remote deltas always have a place to land.
  //
  // **Initial-doc handoff.** If this RichText was produced by an
  // Enter-in-middle split, the splitting block stashed a pre-populated
  // Y.Doc with the suffix content via the focus coordinator's
  // `armForInsert({ initialDoc })`. We consume it here in the lazy
  // initialiser so the very first paint shows the carry-over content
  // — no flash of empty block before the server round-trip completes.
  // The coordinator persists the same doc to the server in the same
  // tick (see `useSurfaceFocus.tsx::onInsert`), so other clients also
  // see the populated block from their first delta.
  const [{ doc, wasPrepopulated }] = useState(() => {
    const initial = focus.consumeInitialDoc(node.id);
    return { doc: initial ?? new Y.Doc(), wasPrepopulated: initial != null };
  });
  const appliedInitialDocRef = useRef(wasPrepopulated);

  // Belt-and-suspenders: if the insert callback landed after first paint,
  // consume the stashed suffix doc here instead of starting empty.
  useLayoutEffect(() => {
    if (appliedInitialDocRef.current) return;
    const initial = focus.consumeInitialDoc(node.id);
    if (!initial) return;
    appliedInitialDocRef.current = true;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(initial), "remote");
  }, [doc, focus, node.id]);
  const lastAppliedAtRef = useRef<bigint | null>(null);

  // Initial hydrate + remote-update reconciliation. `state.data` is the
  // most recent server-side blob; applying it with origin="remote" keeps
  // it out of the local undo stack and the local save loop's dirty bit.
  useEffect(() => {
    if (!state?.data || state.data.byteLength === 0) return;
    const stateStamp = state.updatedAt?.microsSinceUnixEpoch ?? null;
    if (stateStamp != null && lastAppliedAtRef.current === stateStamp) return;
    try {
      Y.applyUpdate(doc, state.data, "remote");
      lastAppliedAtRef.current = stateStamp;
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn(
          `[RichTextRenderer] failed to apply Yjs state for component ${node.id}:`,
          err,
        );
      }
    }
  }, [doc, node.id, state?.data, state?.updatedAt?.microsSinceUnixEpoch]);

  useEffect(() => {
    return () => {
      doc.destroy();
    };
  }, [doc]);

  // Belt-and-suspenders save for the prepopulated-doc case. The focus
  // coordinator's `onInsert` already dispatches `save_component_yjs_
  // state` for split-site content (so other clients see it from their
  // first delta), but that save can fail (network blip, server back-
  // pressure). If it does, the local IndexedDB still has the content
  // — but the `RichTextEditor`'s save loop only flushes on the
  // `dirty` flag, which only flips on local Y.Doc updates, and we
  // injected the content *before* the editor mounted. No update event
  // fires → no flush → server stays empty until the user types. This
  // effect fires once on mount of a prepopulated block to guarantee
  // the server has the content. Idempotent: duplicate writes are
  // harmless (state-replaces-state at the substrate level).
  useEffect(() => {
    if (!wasPrepopulated) return;
    try {
      saveYjsState({
        componentId: node.id,
        data: Y.encodeStateAsUpdate(doc),
      });
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn(
          `[RichTextRenderer] failed to save prepopulated doc for ${node.id}:`,
          err,
        );
      }
    }
    // Run exactly once at mount; the flag is true at most once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Viewport-aware mode switch.
  //
  // Initial state is `true` — blocks default to live mode on mount so that
  // an editable RichText is always ready when the user clicks. The
  // IntersectionObserver, attached after first paint, flips to static only
  // if the block is actually outside the preload band.
  //
  // We start live (not static) for two reasons:
  //   1. Empty RichText nodes have a 0-height bounding box until they get
  //      content. Browsers treat 0-area elements as never-intersecting
  //      with `threshold: 0`, so an empty block would otherwise be stuck
  //      in invisible static mode forever — the user couldn't click into
  //      it to start typing.
  //   2. The cost of mounting a few extra prosemirror views above the
  //      fold is bounded; the cost of users staring at invisible blocks
  //      is not.
  // Far-off-screen blocks transition to static normally on the observer's
  // first poll.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [inViewport, setInViewport] = useState(true);
  const [hasFocus, setHasFocus] = useState(false);

  // Surface-level focus registration — covers static→live transitions
  // when arrow-key navigation targets an off-screen block.
  useLayoutEffect(() => {
    const focusSelf = (placement: FocusPlacement = "end") => {
      setHasFocus(true);
      if (editorApplyFocusRef.current) {
        editorApplyFocusRef.current(placement);
      } else {
        pendingFocusRef.current = placement;
      }
    };
    return focus.registerFocusable(node.id, focusSelf);
  }, [focus, node.id]);

  // Source block: once the tree shows a new sibling below us, drive focus there
  // directly — does not depend on insert-callback timing or coordinator matching.
  useLayoutEffect(() => {
    const handoff = splitHandoffRef.current;
    if (!handoff || !idsMatch(handoff.afterId, node.id)) return;

    const siblings = siblingsForParent(tree, handoff.parentId);
    const afterIdx = siblings.findIndex((s) => idsMatch(s.id, handoff.afterId));
    if (afterIdx < 0) return;

    const candidate = siblings[afterIdx + 1];
    if (!candidate || handoff.knownIds.has(candidate.id.toString())) {
      if (handoff && idsMatch(handoff.afterId, node.id) && !splitHandoffWaitLoggedRef.current) {
        splitHandoffWaitLoggedRef.current = true;
        focusDebug("splitHandoff: waiting for new sibling", {
          sourceId: idStr(node.id),
          afterIdx,
          siblingIds: siblings.map((s) => idStr(s.id)),
          nextId: candidate ? idStr(candidate.id) : null,
          nextIsKnown: candidate
            ? handoff.knownIds.has(candidate.id.toString())
            : false,
        });
      }
      return;
    }

    splitHandoffRef.current = null;
    focusDebug("splitHandoff: requestFocus", {
      sourceId: idStr(node.id),
      targetId: idStr(candidate.id),
    });
    focus.requestFocus(candidate.id, "start");
  }, [tree, node.id, focus]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    // Generous preload band — one viewport above and below — so that
    // scrolling rarely catches a static block mid-transition. § Performance.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setInViewport(entry.isIntersecting);
        }
      },
      { rootMargin: "100% 0px 100% 0px", threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Focus preservation — if this block currently holds focus, stay live
  // even when scrolled out of the preload band. This avoids tearing down
  // the prosemirror view (and the user's IME / selection) on every scroll.
  const live = inViewport || hasFocus;

  // Static-mode HTML — only re-rendered when static mode is active or
  // about to be re-entered. Subscribing to `update` keeps the off-screen
  // HTML fresh as remote deltas arrive.
  const [html, setHtml] = useState<string>(() => yDocToHtml(doc));
  useEffect(() => {
    const update = () => setHtml(yDocToHtml(doc));
    update();
    doc.on("update", update);
    return () => {
      doc.off("update", update);
    };
  }, [doc]);

  return (
    // `min-h-[1.5em]` keeps the wrapper non-zero-height even for empty
    // RichText nodes — required for IntersectionObserver to be able to
    // report intersection at all (zero-area elements never intersect).
    <div ref={hostRef} className="min-h-[1.5em]">
      {live ? (
        <RichTextEditor
          doc={doc}
          componentId={node.id}
          placeholder={props.placeholder}
          textDensity={textDensity}
          shouldClaimFocus={claimInsertFocus}
          onFocus={() => setHasFocus(true)}
          onBlur={() => setHasFocus(false)}
          onSplit={onSplit}
          onDeleteSelf={canBackspaceDeleteEmpty ? onDeleteSelf : undefined}
          onMergeWithPrev={onMergeWithPrev}
          onSlashSessionChange={onSlashSessionChange}
          onSlashNavigate={navigateSlash}
          onSlashCommit={commitSlash}
          onSlashDismiss={dismissSlash}
          suppressSaveRef={suppressSaveRef}
          onNavigatePrev={onNavigatePrev}
          onNavigateNext={onNavigateNext}
          onIndent={onIndent}
          onOutdent={onOutdent}
          bindFocus={bindFocus}
          blockActions={blockActions}
          markdownShortcuts={markdownShortcuts}
          onMarkdownShortcut={onMarkdownShortcut}
          onPaste={onPaste}
          onEscape={onEscape}
        />
      ) : (
        <StaticBody
          html={html}
          placeholder={props.placeholder ?? ""}
          textDensity={textDensity}
        />
      )}
      {slashSession != null && (
        <InlineSlashMenu
          anchorRect={slashSession.rect}
          items={slashFiltered}
          activeIndex={slashActiveIndex}
          onHover={setSlashActiveIndex}
          onSelect={(item) => commitSlash(item)}
          onClose={dismissSlash}
        />
      )}
    </div>
  );
}

const STATIC_BODY_STYLE: CSSProperties = {};

function StaticBody({
  html,
  placeholder,
  textDensity = "default",
}: {
  html: string;
  placeholder: string;
  textDensity?: RichTextTextDensity;
}) {
  const proseClass =
    textDensity === "listItem" ? STATIC_PROSE_LIST_ITEM : STATIC_PROSE_DEFAULT;

  if (!html) {
    return (
      <p
        className={
          textDensity === "listItem"
            ? "my-0 text-neutral-400 dark:text-neutral-600 italic"
            : "my-2 text-neutral-400 dark:text-neutral-600 italic"
        }
      >
        {placeholder}
      </p>
    );
  }
  return (
    <div
      style={STATIC_BODY_STYLE}
      className={proseClass}
      // Same rationale as sprint 1 — yDocToHtml escapes everything; the
      // Y.Doc contents come from a trust boundary we control end-to-end.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function safeParse(s: string): RichTextProps {
  try {
    return JSON.parse(s) as RichTextProps;
  } catch {
    return {};
  }
}

function splitPropsFor(
  componentType: string,
  propsJson: string,
): Record<string, unknown> {
  if (componentType === "ChecklistItem") {
    return { ...safeParseAny(propsJson), checked: false };
  }
  if (
    componentType === "BulletListItem" ||
    componentType === "NumberedListItem"
  ) {
    return safeParseAny(propsJson);
  }
  return {};
}

function safeParseAny(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
