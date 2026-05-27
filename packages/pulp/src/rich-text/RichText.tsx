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
import { Selection } from "prosemirror-state";
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
import { SlashMenu, type SlashMenuItem } from "../SlashMenu";
import { knownSiblingIdsForParent, siblingsForParent, idsMatch } from "../focus/insertFocusHelpers";
import type { FocusPlacement } from "../focus/SurfaceFocusCoordinator";
import { focusDebug, idStr } from "../focus/focusDebug";
import { getBlockSibling } from "../navigation/blockNavigation";

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

export function RichTextRenderer({ node, tree }: BlockRendererProps) {
  const props = useMemo<RichTextProps>(() => safeParse(node.props), [node.props]);
  const state = tree.yjs.get(node.id);
  const { insertBlock, deleteBlock, saveYjsState, config } = usePulp();
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
    const prev = getBlockSibling(tree, node.id, "prev");
    if (!prev) return false;
    focus.requestFocus(prev.id, "end");
    return true;
  }, [tree, node.id, focus]);

  const onNavigateNext = useCallback((): boolean => {
    const next = getBlockSibling(tree, node.id, "next");
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
  // Backspace-on-empty deletes this block AND moves focus to a neighbour,
  // matching Notion/BlockNote: the previous sibling (caret at end), or
  // the next sibling if this is the first child. Without the focus
  // handoff, the user has to click into the next block — small but
  // continually-occurring friction during normal editing flow.
  const onDeleteSelf = canDelete
    ? () => {
        const myIdx = siblings.findIndex((s) => s.id === node.id);
        const neighbour =
          myIdx > 0 ? siblings[myIdx - 1] : siblings[myIdx + 1];
        if (neighbour) focus.requestFocus(neighbour.id, "end");
        removeSelf();
      }
    : undefined;

  // Backspace-at-start-of-non-empty merge: take this block's full
  // content, splice it into the previous sibling's RichText editor as
  // an "open-open" slice (so PM joins this doc's first paragraph onto
  // prev's last paragraph instead of stacking them as separate
  // blocks), then delete this block. Caret lands at the merge point
  // — the position in prev that was previously its end-of-content,
  // which is now where the typed-in text starts.
  //
  // **Why we mutate prev's live view directly** instead of dispatching
  // an `update_component_yjs_state` reducer: the merge needs to land
  // on prev's *editor* (so its undo stack records it, so its
  // selection mapping is in sync, so its IndexedDB persistence picks
  // it up). Going through the substrate would round-trip on the
  // network and create a flicker. Per ADR § Block chrome / Enter &
  // Backspace, the structural side is `delete_component(this)`; the
  // Yjs-content side stays local to this client and is replicated to
  // peers by prev's normal save loop.
  //
  // **Constraints.** Prev must be a `RichText` (text-into-text only at
  // v1) and must be currently *live* (its editor mounted). If prev is
  // a different component type (Heading, Image, …), we fall back to
  // moving focus there — caller's Backspace still feels responsive,
  // and the ADR's "selection-of-block UX" for non-text prevs lands
  // when sprint 3c.5 ships multi-block selection. If prev exists but
  // is in viewport-static mode (off-screen), we no-op the merge so
  // the user doesn't lose content; they can scroll prev into view and
  // try again. In practice prev is almost always live because the
  // user is editing this block and prev is right above it.
  const onMergeWithPrev = (view: EditorView): boolean => {
    if (node.parentId == null) return false;
    const myIdx = siblings.findIndex((s) => s.id === node.id);
    if (myIdx <= 0) return false;
    const prev = siblings[myIdx - 1];

    const prevDef = tree.defs.get(prev.componentType);
    if (!prevDef?.hasYjsState) {
      focus.requestFocus(prev.id);
      return true;
    }
    const prevView = focus.getEditor(prev.id);
    if (!prevView) {
      focus.requestFocus(prev.id);
      return false;
    }

    const prevDocSize = prevView.state.doc.content.size;
    // Merge point in prev = inside the last paragraph at end of content.
    const mergePoint = prevDocSize - 1;
    const myDocSize = view.state.doc.content.size;
    // Slice with both ends "open at depth 1" — strips the outer
    // paragraph wrappers so PM joins boundaries instead of stacking
    // separate paragraphs. For a multi-paragraph current, only the
    // first paragraph joins prev's last; the rest become new
    // paragraphs after.
    const sliceToMerge = view.state.doc.slice(1, myDocSize - 1, true);

    const tr = prevView.state.tr.replace(mergePoint, mergePoint, sliceToMerge);
    tr.setSelection(Selection.near(tr.doc.resolve(mergePoint)));
    prevView.dispatch(tr);
    prevView.focus();

    removeSelf();
    return true;
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
          shouldClaimFocus={claimInsertFocus}
          onFocus={() => setHasFocus(true)}
          onBlur={() => setHasFocus(false)}
          onSplit={onSplit}
          onDeleteSelf={onDeleteSelf}
          onMergeWithPrev={onMergeWithPrev}
          onSlashTrigger={onSlashTrigger}
          suppressSaveRef={suppressSaveRef}
          onNavigatePrev={onNavigatePrev}
          onNavigateNext={onNavigateNext}
          bindFocus={bindFocus}
        />
      ) : (
        <StaticBody html={html} placeholder={props.placeholder ?? ""} />
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
}: {
  html: string;
  placeholder: string;
}) {
  if (!html) {
    return (
      <p className="my-2 text-neutral-400 dark:text-neutral-600 italic">
        {placeholder}
      </p>
    );
  }
  return (
    <div
      style={STATIC_BODY_STYLE}
      className="my-2 text-neutral-900 dark:text-neutral-100 leading-relaxed
                 [&_p]:my-2 [&_a]:underline [&_code]:rounded
                 [&_code]:bg-neutral-100 [&_code]:dark:bg-neutral-800
                 [&_code]:px-1 [&_code]:py-0.5
                 [&_strong]:font-semibold
                 [&_em]:italic
                 [&_u]:underline
                 [&_s]:line-through"
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
