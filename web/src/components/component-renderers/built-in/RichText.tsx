"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import * as Y from "yjs";
import { yDocToHtml } from "@/src/lib/yjsToHtml";
import { useDeleteComponent, useInsertComponent } from "@/src/hooks/usePages";
import { useSurfaceFocus } from "@/src/hooks/useSurfaceFocus";
import type { ComponentRendererProps } from "../registry";
import { RichTextEditor } from "./RichTextEditor";
import { SlashMenu, type SlashMenuItem } from "../SlashMenu";

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

export function RichTextRenderer({ node, tree }: ComponentRendererProps) {
  const props = useMemo<RichTextProps>(() => safeParse(node.props), [node.props]);
  const state = tree.yjs.get(node.id);
  const insertComponent = useInsertComponent();
  const deleteComponent = useDeleteComponent();
  const focus = useSurfaceFocus();

  // Block-boundary structural callbacks — § Block chrome / Enter & Backspace.
  // Enter at end of doc inserts a new RichText sibling immediately below
  // and arms the autofocus coordinator so the new block takes focus on
  // mount (no extra click needed). Backspace at start of an empty doc
  // deletes this block, but only when it isn't the only child (otherwise
  // the user would be stuck with an empty Container and have to fall back
  // to the "+ Add text block" affordance). Both callbacks are fire-and-
  // forget; the subscription delivers the resulting row update and React
  // re-renders.
  const onInsertSiblingBelow = () => {
    if (node.parentId == null) return;
    focus.armForInsert(node.parentId, node.id);
    insertComponent({
      parentId: node.parentId,
      componentType: "RichText",
      propsJson: "{}",
      afterSiblingId: node.id,
    });
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
        if (neighbour) focus.requestFocus(neighbour.id);
        deleteComponent({ componentId: node.id });
      }
    : undefined;

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
    focus.armForInsert(node.parentId, predecessor);
    insertComponent({
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
      deleteComponent({ componentId: node.id });
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
  const doc = useMemo(() => new Y.Doc(), []);
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
          shouldClaimFocus={() => focus.claimFocus(node.id)}
          onFocus={() => setHasFocus(true)}
          onBlur={() => setHasFocus(false)}
          onInsertSiblingBelow={onInsertSiblingBelow}
          onDeleteSelf={onDeleteSelf}
          onSlashTrigger={onSlashTrigger}
        />
      ) : (
        <StaticBody html={html} placeholder={props.placeholder ?? ""} />
      )}
      {slashAnchor != null && (
        <SlashMenu
          anchorRect={slashAnchor}
          onSelect={onSlashSelect}
          onClose={() => setSlashAnchor(null)}
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
