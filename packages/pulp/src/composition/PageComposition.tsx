"use client";

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ContinuousCompositionContext } from "./BlockSource";

export type CompositionLayout = "structured" | "continuous";

function sourceInfo(element: HTMLElement | null, pageLabel: string) {
  if (!element?.isConnected || !element.hasAttribute("data-composition-source")) return null;
  const path: string[] = JSON.parse(element.dataset.sourcePath ?? "[]");
  return {
    element,
    label: path.length ? element.dataset.sourceLabel ?? "Source page" : pageLabel,
    path: [pageLabel, ...path],
    linked: path.length > 0,
    readOnly: element.dataset.sourceReadonly === "true",
    href: element.dataset.sourceHref,
  };
}

/** Presentation only: switching layouts never replaces the editor subtree. */
export function PageComposition({ children, layout, onLayoutChange, pageLabel }: {
  children: ReactNode;
  layout: CompositionLayout;
  onLayoutChange: (layout: CompositionLayout) => void;
  pageLabel: string;
}) {
  const continuous = layout === "continuous";
  const [hovered, setHovered] = useState<HTMLElement | null>(null);
  const [active, setActive] = useState<HTMLElement | null>(null);
  const [details, setDetails] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [, refreshMetadata] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const element = details ? active ?? hovered : hovered ?? active;
  const info = sourceInfo(element, pageLabel);
  const activeInfo = sourceInfo(active, pageLabel);

  function blockAt(target: EventTarget | null) {
    if (!(target instanceof Element) || target.closest("[data-source-overlay],[data-reference-header]")) return null;
    const block = target.closest<HTMLElement>("[data-block-chrome],[data-composition-source]");
    return block && root.current?.contains(block) && block.hasAttribute("data-composition-source") ? block : null;
  }

  useLayoutEffect(() => {
    const surface = root.current;
    if (!continuous || !surface) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (active && !surface.contains(active)) { setActive(null); setDetails(false); }
      if (hovered && !surface.contains(hovered)) setHovered(null);
      if (!element || !surface.contains(element)) return;
      const block = element.getBoundingClientRect(), rect = surface.getBoundingClientRect();
      const top = block.top - rect.top + surface.scrollTop + 6;
      const left = Math.max(0, block.left - rect.left - 78);
      setPosition(previous => previous.top === top && previous.left === left ? previous : { top, left });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    const resize = new ResizeObserver(schedule);
    resize.observe(surface);
    if (element) resize.observe(element);
    // Preceding blocks can move an unchanged active block. Also clear detached
    // source context after deletes, permission changes, or collapsing a section.
    const mutations = new MutationObserver(records => {
      if (records.every(record => record.target instanceof Element && record.target.closest("[data-source-overlay]"))) return;
      if (records.some(record => record.type === "attributes")) refreshMetadata(value => value + 1);
      schedule();
    });
    mutations.observe(surface, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["data-source-label", "data-source-path", "data-source-readonly", "data-source-href"] });
    window.addEventListener("resize", schedule);
    return () => { resize.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("resize", schedule); };
  }, [element, active, hovered, continuous]);

  useLayoutEffect(() => {
    if (!continuous || !element) return;
    element.dataset.sourceCurrent = "true";
    return () => { delete element.dataset.sourceCurrent; };
  }, [element, continuous]);

  useLayoutEffect(() => {
    if (!details) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.querySelector("[data-source-overlay]")?.contains(event.target)) setDetails(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setDetails(false); indicator.current?.focus(); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [details]);

  function changeView(value: CompositionLayout) { onLayoutChange(value); setDetails(false); setHovered(null); }

  return <section className="pulp-composition" data-composition-layout={layout}>
    <div className="pulp-composition-toolbar">
      <div className="pulp-view-switch" role="group" aria-label="Page layout">
        <button type="button" aria-pressed={!continuous} onMouseDown={event => event.preventDefault()} onClick={() => changeView("structured")}>Structured</button>
        <button type="button" aria-pressed={continuous} onMouseDown={event => event.preventDefault()} onClick={() => changeView("continuous")}>Continuous</button>
      </div>
    </div>
    <div className="pulp-composition-context" aria-live="polite">
      {continuous ? activeInfo
        ? <><span>{activeInfo.readOnly ? "Viewing" : "Editing"}</span><strong>{activeInfo.label}</strong><span>{activeInfo.readOnly ? "· read only" : activeInfo.linked ? "· shared source" : ""}</span></>
        : <span>Hover or focus a block to see its source.</span>
        : <span>Arrange sections and manage their references.</span>}
    </div>
    <div ref={root} className="pulp-composition-editor"
      onPointerMoveCapture={event => {
        if (details || (event.target as Element).closest("[data-source-overlay]")) return;
        const block = blockAt(event.target);
        if (!block && hovered) {
          const rect = hovered.getBoundingClientRect();
          // Keep the marker reachable across the empty gutter between it and text.
          if (event.clientX >= rect.left - 80 && event.clientX <= rect.left
            && event.clientY >= rect.top && event.clientY <= rect.bottom) return;
        }
        setHovered(block);
      }}
      onPointerLeave={() => { if (!details) setHovered(null); }}
      onFocusCapture={event => {
        const block = blockAt(event.target);
        if (block) { setActive(block); setHovered(null); }
        else if (!(event.target as Element).closest("[data-source-overlay]")) { setActive(null); setHovered(null); }
      }}>
      <ContinuousCompositionContext.Provider value={continuous}>{children}</ContinuousCompositionContext.Provider>
      {continuous && info && <div className="pulp-source-overlay" data-source-overlay style={position}>
        <button ref={indicator} type="button" className="pulp-source-marker"
          title={`Source: ${info.label}${info.readOnly ? " (read only)" : ""}`} aria-label={`Source details: ${info.label}`}
          aria-expanded={details} aria-controls={details ? popoverId : undefined}
          onClick={() => { if (!details) setActive(info.element); setDetails(!details); }}>
          {info.linked ? <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6.5 5 2-2a3.18 3.18 0 0 1 4.5 4.5l-2 2M5 6.5l-2 2a3.18 3.18 0 0 0 4.5 4.5l2-2M5.5 10.5l5-5" />
          </svg> : <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" aria-hidden="true"><path d="M4 2.5h6l2 2V14H4zM7 7h3M7 10h3"/></svg>}
        </button>
        {details && <div id={popoverId} className="pulp-source-popover" role="group" aria-label="Block source">
          <p className="pulp-source-eyebrow">{info.readOnly ? "Read-only content" : info.linked ? "Editing shared content" : "Content on this page"}</p>
          <p className="pulp-source-name">{info.label}</p>
          {info.linked && <p className="pulp-source-path">{info.path.join(" › ")}</p>}
          <p className="pulp-source-explanation">{info.readOnly ? "You can view this source here, but cannot edit it." : info.linked ? "Edits update the original and every reference to it." : "This block belongs to this page."}</p>
          <div className="pulp-source-actions">
            {info.href && <a href={info.href}>Open source ↗</a>}
            <button type="button" onClick={() => changeView("structured")}>Show structure</button>
          </div>
        </div>}
      </div>}
    </div>
  </section>;
}
