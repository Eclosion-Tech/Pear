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
import { splitBlock } from "prosemirror-commands";
import { prosemirrorToYDoc } from "y-prosemirror";
import { yDocToHtml } from "./yjsToHtml";
import { usePulp } from "../context/PulpProvider";
import { useSurfaceFocus } from "../focus/SurfaceFocusProvider";
import { PROSEMIRROR_FRAGMENT_KEY } from "./richTextSchema";
import type { BlockRendererProps } from "../registry";
import type { BlockId } from "../types";
import { RichTextEditor } from "./RichTextEditor";
import { SlashMenu, SPRINT_3B_SLASH_ITEMS, type SlashMenuItem } from "../SlashMenu";
import { turnIntoToolbarItems } from "../toolbarTurnIntoItems";
import { knownSiblingIdsForParent, siblingsForParent, idsMatch } from "../focus/insertFocusHelpers";
import type { FocusPlacement } from "../focus/SurfaceFocusCoordinator";
import { focusDebug, idStr } from "../focus/focusDebug";
import { getDocumentPrevBlock, getDocumentNextBlock } from "../navigation/blockNavigation";
import {
  exitEmptyListItemToRichText,
  isDocumentListItemType,
  nestBlockUnderPreviousSibling,
  unnestBlock,
  turnIntoBlock,
  canNestBlock,
  canUnnestBlock,
  deleteEmptyBlockAndFocusDocumentPrev,
  mergeBlockIntoDocumentPrev,
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

export function RichTextRenderer({
  node,
  tree,
  textDensity = "default",
}: BlockRendererProps & { textDensity?: RichTextTextDensity }) {
  const props = useMemo<RichTextProps>(() => safeParse(node.props), [node.props]);
  const state = tree.yjs.get(node.id);
  const { insertBlock, deleteBlock, moveBlock, saveYjsState, config, updateBlockProps } = usePulp();
  const focus = useSurfaceFocus();
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

  const onNavigatePrev = useCallback((): boolean => {
    const prev = getDocumentPrevBlock(tree, node.id);
    if (!prev) return false;
    focus.requestFocus(prev.id, "end");
    return true;
  }, [tree, node.id, focus]);

  const onNavigateNext = useCallback((): boolean => {
    const next = getDocumentNextBlock(tree, node.id);
    if (!next) return false;
    focus.requestFocus(next.id, "start");
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
        { insertBlock, deleteBlock },
        focus,
      );
    }

    // Apply ProseMirror's built-in splitBlock — handles all positions
    // (start / middle / end of a paragraph, at boundaries between
    // paragraphs) and produces a clean paragraph structure. If
    // splitBlock can't apply at the current cursor (e.g. inside a
    // node that doesn't allow splits), fall through to default Enter
    // behaviour so the user isn't stuck.
    const splitWorked = splitBlock(view.state, view.dispatch);
    if (!splitWorked) return false;

    const afterState = view.state;
    const cursorAfterSplit = afterState.selection.from;
    // boundary = doc-level position of the new paragraph's opening tag.
    const boundary = cursorAfterSplit - 1;
    const docEnd = afterState.doc.content.size;
    if (boundary < 0 || boundary > docEnd) return false;

    // Extract suffix as a clean doc node (boundaries are at paragraph
    // openings/closings, so `Node.cut` returns full paragraphs).
    const suffixDoc = afterState.doc.cut(boundary, docEnd);
    const initialDoc = prosemirrorToYDoc(suffixDoc, PROSEMIRROR_FRAGMENT_KEY);

    // Truncate this doc — drop everything from the new-paragraph
    // boundary to end. Single transaction, single Yjs update.
    view.dispatch(afterState.tr.delete(boundary, docEnd));

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
    if (
      deleteEmptyBlockAndFocusDocumentPrev(node, tree, focus, deleteBlock)
    ) {
      return;
    }
    if (isDocumentListItemType(node.componentType)) {
      exitEmptyListItemToRichText(
        node,
        tree,
        { insertBlock, deleteBlock },
        focus,
      );
    }
  }, [node, tree, focus, deleteBlock, insertBlock]);

  const canBackspaceDeleteEmpty =
    getDocumentPrevBlock(tree, node.id) != null ||
    canDelete ||
    isDocumentListItemType(node.componentType);

  const onMergeWithPrev = (view: EditorView): boolean => {
    suppressSaveRef.current = true;
    return mergeBlockIntoDocumentPrev(
      node,
      view,
      tree,
      focus,
      saveYjsState,
      removeSelf,
    );
  };

  // Slash-menu state — when the user types `/` at start of empty doc,
  // RichTextEditor calls onSlashTrigger with the cursor rect; we open the
  // popover at that anchor. On select we *replace* this empty RichText
  // with the chosen block type (insert new at this position, then delete
  // this one). Two reducer calls, both fire-and-forget; the subscription
  // delivers both deltas atomically from the user's perspective.
  const [slashAnchor, setSlashAnchor] = useState<DOMRect | null>(null);
  const onSlashTrigger = (cursorRect: DOMRect) => setSlashAnchor(cursorRect);
  const onSlashSelect = (item: SlashMenuItem) => {
    setSlashAnchor(null);
    if (node.parentId == null) return;
    // The new block lands where this RichText currently is. Compute the
    // predecessor in the parent's child list; that's the afterSiblingId
    // for the insert. Empty siblings array → undefined → first child.
    const parentSiblings = tree.byParent.get(node.parentId) ?? [];
    const myIdx = parentSiblings.findIndex((s) => s.id === node.id);
    const predecessor =
      myIdx > 0 ? parentSiblings[myIdx - 1]?.id : undefined;
    focus.armForInsert(node.parentId, predecessor, {
      knownSiblingIds: knownSiblingIdsForParent(tree, node.parentId),
    });
    insertBlock({
      parentId: node.parentId,
      componentType: item.componentType,
      propsJson: JSON.stringify(item.defaultProps),
      afterSiblingId: predecessor,
    });
    // Only delete the host RichText when it has at least one sibling —
    // otherwise the parent Container would be left empty (briefly) and
    // the user would see the empty-state affordance flash. With siblings
    // present, the new block visually takes this block's slot.
    if (parentSiblings.length > 1) {
      removeSelf();
    } else {
      // Only-child case: keep the empty RichText so the Container isn't
      // empty-state. The user can Backspace to clean up later once the
      // new block has content. This matches BlockNote's "the original
      // line stays until you type" feel and avoids the parent flicker.
    }
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
          onSlashTrigger={onSlashTrigger}
          suppressSaveRef={suppressSaveRef}
          onNavigatePrev={onNavigatePrev}
          onNavigateNext={onNavigateNext}
          onIndent={onIndent}
          onOutdent={onOutdent}
          bindFocus={bindFocus}
          blockActions={blockActions}
        />
      ) : (
        <StaticBody
          html={html}
          placeholder={props.placeholder ?? ""}
          textDensity={textDensity}
        />
      )}
      {slashAnchor != null && (
        <SlashMenu
          anchorRect={slashAnchor}
          onSelect={onSlashSelect}
          onClose={() => setSlashAnchor(null)}
          items={config.slashItems}
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
