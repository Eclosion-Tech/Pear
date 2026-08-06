"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import {
  useCloseConversation,
  useReopenConversation,
} from "@/src/hooks/useConversations";

/**
 * Renders a marker in the editor's right gutter aligned to each block that has
 * a block-anchored conversation (see `Conversation.block_anchor`). Clicking a
 * marker opens a card listing that block's threads, where each can be opened or
 * resolved; hovering an unthreaded block offers a quiet create affordance.
 *
 * Positioning is measured from the live DOM: pulp's `BlockChrome` gives each
 * block element `id="block-<ComponentNode.id>"`, which matches the
 * `block_anchor` (node id) we persist. Positions are recomputed on
 * content/layout changes via observers.
 *
 * ## Resolving
 *
 * Resolve behaves like resolving a comment in a document: the thread collapses
 * out of the page and can be brought back. It is **not** just a UI state — the
 * module refuses new messages on a non-Active conversation, so resolving really
 * ends a thread. That is also what stops two AI users continuing to talk to each
 * other in a comment thread, so the tidy-up affordance and the safety mechanism
 * are the same mechanism (ticket 14264).
 *
 * Resolved threads are hidden by default and revealed per-block, which keeps
 * finished agent chatter from cluttering a page while leaving it recoverable.
 */

/** Sentinel anchor key for the detached-threads card. */
const DETACHED_KEY = "__detached__";

type ThreadRow = {
  id: bigint;
  resolved: boolean;
  resolvedBy: { toHexString(): string } | undefined;
};

type BlockThreads = {
  anchor: string;
  active: ThreadRow[];
  resolved: ThreadRow[];
};

export function BlockThreadGutter({
  containerRef,
  pageId,
  onOpenThread,
  onCreateThread,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  pageId: bigint;
  onOpenThread: (conversationId: bigint) => void;
  onCreateThread: (blockId: bigint) => void;
}) {
  const [conversations] = useTable(tables.conversation);
  const [aiProfiles] = useTable(tables.ai_user_profile);
  const [users] = useTable(tables.user);
  const closeConversation = useCloseConversation();
  const reopenConversation = useReopenConversation();

  /** Identity → a human-readable name, for "Resolved by …". */
  const nameFor = useCallback(
    (identity: { toHexString(): string } | undefined): string => {
      if (!identity) return "someone";
      const hex = identity.toHexString();
      const ai = aiProfiles.find((p) => p.identity.toHexString() === hex);
      if (ai) return ai.displayName;
      const user = users.find((u) => u.identity.toHexString() === hex);
      if (user && user.name.trim()) return user.name;
      return `${hex.slice(0, 8)}…`;
    },
    [aiProfiles, users],
  );

  // Block-anchored threads on this page, grouped by anchor and split by status.
  const byBlock = useMemo(() => {
    const map = new Map<string, BlockThreads>();
    for (const c of conversations) {
      if (c.pageId !== pageId) continue;
      if (c.kind.tag !== "ContextThread") continue;
      if (c.blockAnchor == null) continue;
      const anchor = c.blockAnchor.toString();
      const entry = map.get(anchor) ?? { anchor, active: [], resolved: [] };
      const row: ThreadRow = {
        id: c.id,
        resolved: c.status.tag !== "Active",
        resolvedBy: c.resolvedBy,
      };
      (row.resolved ? entry.resolved : entry.active).push(row);
      map.set(anchor, entry);
    }
    return map;
  }, [conversations, pageId]);

  // Stable key so the measurement effect re-runs when the anchor set changes.
  const anchorsKey = [...byBlock.keys()].sort().join(",");

  const [positions, setPositions] = useState<{ top: number; threads: BlockThreads }[]>([]);
  /**
   * Threads whose anchor block is no longer on the page.
   *
   * Block deletion is a *soft* delete that never clears `block_anchor`, so the
   * node still exists but is filtered out of the render — which used to make the
   * thread silently vanish while staying Active. Surfacing them detached keeps
   * the discussion reachable, and because nothing is mutated they re-attach on
   * their own if the block is restored.
   *
   * Deliberately not re-anchored to a sibling: the conversation was about the
   * deleted block, and silently pointing it at a neighbour would assert
   * something untrue and would survive an undo.
   */
  const [detached, setDetached] = useState<BlockThreads[]>([]);
  const [openAnchor, setOpenAnchor] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState<Set<string>>(new Set());
  const [hoveredBlock, setHoveredBlock] = useState<{ anchor: string; top: number } | null>(null);
  const hoverClearTimerRef = useRef<number | null>(null);

  const cancelHoverClear = useCallback(() => {
    if (hoverClearTimerRef.current == null) return;
    window.clearTimeout(hoverClearTimerRef.current);
    hoverClearTimerRef.current = null;
  }, []);

  const scheduleHoverClear = useCallback(() => {
    cancelHoverClear();
    hoverClearTimerRef.current = window.setTimeout(() => {
      hoverClearTimerRef.current = null;
      setHoveredBlock(null);
    }, 120);
  }, [cancelHoverClear]);

  useEffect(
    () => () => {
      if (hoverClearTimerRef.current != null) {
        window.clearTimeout(hoverClearTimerRef.current);
      }
    },
    [],
  );

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    // Zero anchored threads (the common case) must cost zero layout work —
    // this runs from a MutationObserver on the editor container, i.e. on
    // every edit. Functional updates keep the previous (empty) array
    // identity so the bail-out doesn't itself cause a re-render.
    if (byBlock.size === 0) {
      setPositions((prev) => (prev.length === 0 ? prev : []));
      setDetached((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const containerTop = container.getBoundingClientRect().top;
    const next: { top: number; threads: BlockThreads }[] = [];
    const orphans: BlockThreads[] = [];
    for (const threads of byBlock.values()) {
      // pulp renders each block element with id="block-<nodeId>".
      const el = container.querySelector(`[id="block-${threads.anchor}"]`);
      if (!el) {
        orphans.push(threads);
        continue;
      }
      const top = el.getBoundingClientRect().top - containerTop + container.scrollTop;
      next.push({ top, threads });
    }
    // Preserve array identity when nothing moved so a no-op measure is a
    // no-op render. `threads` objects come from the byBlock memo, so
    // reference equality is meaningful.
    setPositions((prev) =>
      prev.length === next.length &&
      prev.every(
        (p, i) => p.top === next[i].top && p.threads === next[i].threads,
      )
        ? prev
        : next,
    );
    setDetached((prev) =>
      prev.length === orphans.length && prev.every((p, i) => p === orphans[i])
        ? prev
        : orphans,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, anchorsKey, byBlock]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // Recompute on editor content / size changes and window resize. Not
  // attached at all while the page has no anchored threads. `characterData`
  // is deliberately omitted: pure text edits that shift layout also produce
  // childList mutations (ProseMirror splits/merges text nodes) or resize the
  // container (ResizeObserver below), so watching every keystroke's
  // character data only bought extra forced layouts.
  useEffect(() => {
    if (byBlock.size === 0) return;
    const container = containerRef.current;
    if (!container) return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(container, { childList: true, subtree: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(container);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [containerRef, measure, byBlock.size]);

  // One delegated listener covers every live block, including pages with no
  // existing threads. It only measures the block currently under the pointer,
  // leaving the observer-based positioning for real thread pills unchanged.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function onPointerMove(e: PointerEvent) {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-add-thread-pill]")) return;
      cancelHoverClear();

      const block = target.closest<HTMLElement>("[data-block-chrome][id^='block-']");
      if (!block || !container?.contains(block)) {
        setHoveredBlock(null);
        return;
      }

      const anchor = block.id.slice("block-".length);
      if (!anchor || byBlock.has(anchor)) {
        setHoveredBlock(null);
        return;
      }

      const containerTop = container.getBoundingClientRect().top;
      const top = block.getBoundingClientRect().top - containerTop + container.scrollTop;
      setHoveredBlock((previous) =>
        previous?.anchor === anchor && previous.top === top ? previous : { anchor, top },
      );
    }

    function onPointerLeave() {
      scheduleHoverClear();
    }

    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerleave", onPointerLeave);
    return () => {
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [byBlock, cancelHoverClear, containerRef, scheduleHoverClear]);

  // Dismiss the card on outside click / Escape.
  const cardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openAnchor) return;
    function onPointerDown(e: MouseEvent) {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        setOpenAnchor(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenAnchor(null);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openAnchor]);

  const addThreadTarget =
    hoveredBlock && !byBlock.has(hoveredBlock.anchor) ? hoveredBlock : null;

  if (positions.length === 0 && detached.length === 0 && !addThreadTarget) return null;

  const detachedActive = detached.reduce((n, t) => n + t.active.length, 0);
  const detachedResolved = detached.reduce((n, t) => n + t.resolved.length, 0);
  const detachedOpen = openAnchor === DETACHED_KEY;

  return (
    // Overlay spans the container; only the controls capture pointer events so
    // the editor underneath stays fully interactive.
    <div className="pointer-events-none absolute inset-0 z-10">
      {addThreadTarget && (
        <div
          style={{ top: addThreadTarget.top }}
          className="absolute -right-7"
          data-add-thread-pill
          onPointerEnter={cancelHoverClear}
          onPointerLeave={scheduleHoverClear}
        >
          <button
            type="button"
            onClick={() => {
              cancelHoverClear();
              onCreateThread(BigInt(addThreadTarget.anchor));
              setHoveredBlock(null);
            }}
            className="pointer-events-auto flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-neutral-400 shadow-sm ring-1 ring-neutral-300/70 transition-colors hover:bg-violet-50 hover:text-violet-600 hover:ring-violet-300 dark:bg-neutral-900/90 dark:text-neutral-500 dark:ring-neutral-700 dark:hover:bg-violet-950/70 dark:hover:text-violet-300 dark:hover:ring-violet-700"
            title="Add comment thread"
            aria-label="Add comment thread"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <line x1="12" y1="7" x2="12" y2="13" />
              <line x1="9" y1="10" x2="15" y2="10" />
            </svg>
          </button>
        </div>
      )}
      {detached.length > 0 && (
        <div style={{ top: 0 }} className="absolute -right-7">
          <button
            onClick={() => setOpenAnchor(detachedOpen ? null : DETACHED_KEY)}
            className="pointer-events-auto flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full bg-amber-100 px-1 text-[10px] font-medium text-amber-700 shadow-sm ring-1 ring-amber-300/50 transition-colors hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-300 dark:ring-amber-700/50 dark:hover:bg-amber-900/80"
            title={`${detachedActive + detachedResolved} thread(s) whose block was deleted`}
          >
            ⚠
            {detachedActive + detachedResolved > 1 && (
              <span>{detachedActive + detachedResolved}</span>
            )}
          </button>

          {detachedOpen && (
            <div
              ref={cardRef}
              className="pointer-events-auto absolute right-0 top-6 z-20 w-64 rounded-md border border-neutral-200 bg-white p-1.5 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
            >
              <p className="px-1.5 py-1 text-[10px] leading-tight text-neutral-500 dark:text-neutral-400">
                The block these were about was deleted. They will re-attach if it
                is restored.
              </p>
              {detached.flatMap((t) => [...t.active, ...t.resolved]).map((t) => (
                <div
                  key={String(t.id)}
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-neutral-50 dark:hover:bg-neutral-800"
                >
                  <button
                    onClick={() => {
                      onOpenThread(t.id);
                      setOpenAnchor(null);
                    }}
                    className="flex-1 truncate text-left text-neutral-700 dark:text-neutral-200"
                  >
                    {t.resolved ? (
                      <span className="text-neutral-400 dark:text-neutral-500">
                        Resolved by {nameFor(t.resolvedBy)}
                      </span>
                    ) : (
                      <span>Thread #{String(t.id)}</span>
                    )}
                  </button>
                  <button
                    onClick={() =>
                      t.resolved
                        ? reopenConversation({ conversationId: t.id })
                        : closeConversation({ conversationId: t.id })
                    }
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 ring-1 ring-neutral-200 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:ring-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                  >
                    {t.resolved ? "Reopen" : "Resolve"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {positions.map(({ top, threads }) => {
        const { anchor, active, resolved } = threads;
        // A block whose threads are all resolved shows a muted marker rather
        // than vanishing — the conversation happened, and losing the trace
        // entirely is worse than a quiet dot.
        const isAllResolved = active.length === 0;
        const revealed = showResolved.has(anchor);
        const listed = revealed ? [...active, ...resolved] : active.length > 0 ? active : resolved;

        return (
          <div key={anchor} style={{ top }} className="absolute -right-7">
            <button
              onClick={() => setOpenAnchor(openAnchor === anchor ? null : anchor)}
              className={`pointer-events-auto flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full px-1 text-[10px] font-medium shadow-sm ring-1 transition-colors ${
                isAllResolved
                  ? "bg-neutral-100 text-neutral-400 ring-neutral-300/50 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-500 dark:ring-neutral-700/50 dark:hover:bg-neutral-700"
                  : "bg-violet-100 text-violet-700 ring-violet-300/50 hover:bg-violet-200 dark:bg-violet-900/50 dark:text-violet-300 dark:ring-violet-700/50 dark:hover:bg-violet-900/80"
              }`}
              title={
                isAllResolved
                  ? `${resolved.length} resolved thread${resolved.length === 1 ? "" : "s"}`
                  : `${active.length} thread${active.length === 1 ? "" : "s"} on this block`
              }
            >
              {isAllResolved ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              )}
              {active.length > 1 && <span>{active.length}</span>}
            </button>

            {openAnchor === anchor && (
              <div
                ref={cardRef}
                className="pointer-events-auto absolute right-0 top-6 z-20 w-64 rounded-md border border-neutral-200 bg-white p-1.5 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
              >
                {listed.map((t) => (
                  <div
                    key={String(t.id)}
                    className="flex items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-neutral-50 dark:hover:bg-neutral-800"
                  >
                    <button
                      onClick={() => {
                        onOpenThread(t.id);
                        setOpenAnchor(null);
                      }}
                      className="flex-1 truncate text-left text-neutral-700 dark:text-neutral-200"
                    >
                      {t.resolved ? (
                        <span className="text-neutral-400 dark:text-neutral-500">
                          Resolved by {nameFor(t.resolvedBy)}
                        </span>
                      ) : (
                        <span>Thread #{String(t.id)}</span>
                      )}
                    </button>
                    <button
                      onClick={() =>
                        t.resolved
                          ? reopenConversation({ conversationId: t.id })
                          : closeConversation({ conversationId: t.id })
                      }
                      className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 ring-1 ring-neutral-200 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:ring-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                      title={
                        t.resolved
                          ? "Reopen this thread so messages can be posted again"
                          : "Resolve — collapses the thread and stops further replies"
                      }
                    >
                      {t.resolved ? "Reopen" : "Resolve"}
                    </button>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={() => {
                    onCreateThread(BigInt(anchor));
                    setOpenAnchor(null);
                  }}
                  className="mt-1 flex w-full items-center gap-1 rounded border-t border-neutral-100 px-1.5 py-1.5 text-left text-[10px] font-medium text-neutral-400 transition-colors hover:bg-neutral-50 hover:text-violet-600 dark:border-neutral-800 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-violet-300"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  New thread
                </button>

                {resolved.length > 0 && active.length > 0 && (
                  <button
                    onClick={() =>
                      setShowResolved((prev) => {
                        const next = new Set(prev);
                        if (next.has(anchor)) next.delete(anchor);
                        else next.add(anchor);
                        return next;
                      })
                    }
                    className="mt-0.5 w-full rounded px-1.5 py-1 text-left text-[10px] text-neutral-400 hover:bg-neutral-50 hover:text-neutral-600 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                  >
                    {revealed
                      ? "Hide resolved"
                      : `Show ${resolved.length} resolved`}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
