"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";

/**
 * Renders a marker in the editor's right gutter aligned to each block that has
 * a block-anchored conversation (a ContextThread created by an @mention on that
 * block — see `Conversation.block_anchor`). Clicking a marker opens that thread
 * in the AI panel.
 *
 * Positioning is measured from the live DOM: pulp's `BlockChrome` gives each
 * block element `id="block-<ComponentNode.id>"`, which matches the
 * `block_anchor` (node id) we persist. Positions are recomputed on
 * content/layout changes via observers.
 */
export function BlockThreadGutter({
  containerRef,
  pageId,
  onOpenThread,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  pageId: bigint;
  onOpenThread: (conversationId: bigint) => void;
}) {
  const [conversations] = useTable(tables.conversation);

  // Block-anchored, active threads on this page, grouped by anchor node id.
  const byBlock = new Map<string, bigint[]>();
  for (const c of conversations) {
    if (c.pageId !== pageId) continue;
    if (c.kind.tag !== "ContextThread") continue;
    if (c.status.tag !== "Active") continue;
    if (c.blockAnchor == null) continue;
    const anchor = c.blockAnchor.toString();
    const list = byBlock.get(anchor) ?? [];
    list.push(c.id);
    byBlock.set(anchor, list);
  }

  // Stable key so the measurement effect re-runs when the anchor set changes.
  const anchorsKey = [...byBlock.keys()].sort().join(",");

  const [positions, setPositions] = useState<
    { anchor: string; top: number; convIds: bigint[] }[]
  >([]);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    const next: { anchor: string; top: number; convIds: bigint[] }[] = [];
    for (const [anchor, convIds] of byBlock) {
      // pulp renders each block element with id="block-<nodeId>".
      const el = container.querySelector(`[id="block-${anchor}"]`);
      if (!el) continue;
      const top = el.getBoundingClientRect().top - containerTop + container.scrollTop;
      next.push({ anchor, top, convIds });
    }
    setPositions(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, anchorsKey]);

  // Measure after paint and whenever the anchor set changes.
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // Recompute on editor content / size changes and window resize.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(container, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(container);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [containerRef, measure]);

  if (positions.length === 0) return null;

  return (
    // Overlay spans the container; only the dots capture pointer events so the
    // editor underneath stays fully interactive.
    <div className="pointer-events-none absolute inset-0 z-10">
      {positions.map(({ anchor, top, convIds }) => (
        <button
          key={anchor}
          onClick={() => onOpenThread(convIds[0]!)}
          style={{ top }}
          className="pointer-events-auto absolute -right-7 flex h-5 min-w-5 items-center justify-center gap-0.5 rounded-full bg-violet-100 px-1 text-[10px] font-medium text-violet-700 shadow-sm ring-1 ring-violet-300/50 transition-colors hover:bg-violet-200 dark:bg-violet-900/50 dark:text-violet-300 dark:ring-violet-700/50 dark:hover:bg-violet-900/80"
          title={`${convIds.length} thread${convIds.length === 1 ? "" : "s"} on this block`}
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
          </svg>
          {convIds.length > 1 && <span>{convIds.length}</span>}
        </button>
      ))}
    </div>
  );
}
