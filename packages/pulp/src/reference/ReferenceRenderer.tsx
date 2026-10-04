"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BlockRendererProps } from "../registry";
import { usePulp, PulpProvider } from "../context/PulpProvider";
import { BlockEditor } from "../BlockEditor";
import { BlockView } from "../BlockView";
import { BlockChromeHeaderControls } from "../BlockChrome";
import { BlockChromeHandlesProvider } from "../BlockChromeHandlesContext";
import { SurfaceFocusCoordinator, SurfaceFocusProvider } from "../focus/SurfaceFocusProvider";
import { SurfaceUndoCoordinator, SurfaceUndoProvider } from "../undo/SurfaceUndoProvider";
import { BlockOccurrenceContext, sourceKey, useBlockOccurrence } from "./BlockOccurrence";
import { parseReferenceProps, referenceProps, referenceTree,
  type BlockReferenceTarget, type ReferenceSource } from "./types";

const sourceActionClass = "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-black/5 hover:text-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-neutral-400 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100";

export function ReferenceRenderer({ node }: BlockRendererProps) {
  const { config, updateBlockProps } = usePulp();
  const occurrence = useBlockOccurrence();
  const target = useMemo(() => parseReferenceProps(node.props), [node.props]);
  const [expanded, setExpanded] = useState(occurrence.referenceDepth < 2);
  const [choosing, setChoosing] = useState(false);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const frameRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (visible || !frameRef.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "100% 0px" });
    observer.observe(frameRef.current);
    return () => observer.disconnect();
  }, [visible]);
  const adapter = config.references;
  const sourceTitle = target && config.linkTargets?.find((item) => item.id === String(target.surfaceId))?.label;
  const title = sourceTitle ? `${sourceTitle}${target?.blockId ? " · section" : ""}` : "Referenced content";
  const choose = (next: BlockReferenceTarget) => {
    updateBlockProps({ componentId: node.id, propsJson: referenceProps(next) });
    setChoosing(false); setExpanded(true); setError("");
  };
  const Source = adapter?.Source;
  const childOccurrence = useMemo(() => ({ ...occurrence,
    prefix: `${occurrence.prefix}ref-${node.id}-`, referenceDepth: occurrence.referenceDepth + 1,
  }), [occurrence, node.id]);
  const tint = occurrence.referenceDepth % 2 === 0
    ? "bg-slate-50/80 ring-slate-200/60 dark:bg-slate-800/40 dark:ring-slate-700/40"
    : "bg-slate-100/80 ring-slate-200/70 dark:bg-slate-700/30 dark:ring-slate-600/40";

  return <section ref={frameRef} data-reference-block={String(node.id)}
    className={`my-2 min-w-0 rounded-md ring-1 ring-inset ${tint} focus-within:ring-neutral-300 dark:focus-within:ring-neutral-600 ${occurrence.referenceDepth >= 2 ? "-ml-12 -mr-2" : ""}`}>
    <div className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-neutral-500 dark:text-neutral-400">
      {!config.readOnly && <BlockChromeHeaderControls />}
      {target && <button type="button" aria-label={expanded ? "Collapse reference" : "Expand reference"}
        title={expanded ? "Collapse reference" : "Expand reference"}
        aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className={sourceActionClass}>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d={expanded ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>}
      <span className="min-w-0 flex-1 truncate" title={target ? title : "Reference"}>{target ? title : "Reference"}</span>
      {target && adapter && <a href={adapter.href(target)} className={sourceActionClass} title="Open source" aria-label="Open source">
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 3h4v4M13 3 7 9M6 3H3v10h10v-3" />
        </svg>
      </a>}
      {!config.readOnly && target && <button type="button" onClick={() => setChoosing(!choosing)} className={sourceActionClass}
        title="Change source" aria-label="Change source" aria-expanded={choosing}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6.5 5 2-2a3.18 3.18 0 0 1 4.5 4.5l-2 2M5 6.5l-2 2a3.18 3.18 0 0 0 4.5 4.5l2-2M5.5 10.5l5-5" />
        </svg>
      </button>}
    </div>
    {(!target || choosing) && !config.readOnly && <div className="space-y-2 border-t border-neutral-100 p-3 dark:border-neutral-800">
      {!adapter ? <p className="text-sm text-neutral-500">References are not available in this workspace.</p> : <>
        <form className="flex gap-2" onSubmit={(event) => {
          event.preventDefault();
          const next = adapter.parseLink(link.trim());
          if (next) choose(next); else setError("Paste a page or block link from this workspace.");
        }}>
          <input aria-label="Source page or block link" placeholder="Paste a page or block link"
            value={link} onChange={(event) => setLink(event.target.value)}
            className="min-w-0 flex-1 rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-600" />
          <button type="submit" className="rounded bg-neutral-100 px-3 text-sm dark:bg-neutral-800">Include</button>
        </form>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <select aria-label="Choose source page" value="" className="w-full rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-600"
          onChange={(event) => { if (event.target.value) choose({ surfaceId: BigInt(event.target.value) }); }}>
          <option value="">Or choose a page…</option>
          {config.linkTargets?.filter((item) => /^[1-9]\d*$/.test(item.id)).map((item) =>
            <option key={item.id} value={item.id}>{item.subtitle ? `${item.subtitle} / ` : ""}{item.label}</option>)}
        </select>
        <p className="text-xs text-neutral-500">Edits here update the source. Removing this reference keeps the source.</p>
      </>}
    </div>}
    {target && expanded && visible && (Source ? <BlockOccurrenceContext.Provider value={childOccurrence}>
      <Source key={`${target.surfaceId}:${target.blockId ?? "page"}`} target={target}>
        {(source) => <ReferenceContents source={source} target={target} />}
      </Source>
    </BlockOccurrenceContext.Provider> : <p className="p-3 text-sm text-neutral-500">Open the source to view this content.</p>)}
  </section>;
}

function ReferenceContents({ source, target }: { source: ReferenceSource; target: BlockReferenceTarget }) {
  const { config } = usePulp();
  const occurrence = useBlockOccurrence();
  const tree = useMemo(() => referenceTree(source.tree, target), [source.tree, target]);
  if (tree.loading) return <p role="status" className="p-3 text-sm text-neutral-500">Loading source…</p>;
  if (!tree.root) return <p role="status" className="p-3 text-sm text-neutral-500">Source unavailable. It may have been removed or access may have changed.</p>;
  if (occurrence.ancestors.includes(sourceKey(tree.root))) {
    return <p role="status" className="p-3 text-sm text-neutral-500">Circular reference — use Open source to view it.</p>;
  }
  return <div className="pb-2 pl-12 pr-2"
    data-reference-content>
    <BlockChromeHandlesProvider value={null}>
      <ReferenceEditor source={{ ...source, tree }} config={config} />
    </BlockChromeHandlesProvider>
  </div>;
}

function ReferenceEditor({ source, config }: { source: ReferenceSource; config: import("../types").PulpConfig }) {
  const { tree } = source;
  const [focus] = useState(() => new SurfaceFocusCoordinator());
  const [undo] = useState(() => new SurfaceUndoCoordinator());
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const known = useRef(new Set(tree.byId.keys()));
  const mutations = useMemo(() => undo.wrapMutations(source.mutations, () => treeRef.current), [undo, source.mutations]);
  const mergedConfig = useMemo(() => ({ ...config, ...source.config,
    readOnly: config.readOnly || source.readOnly || source.config?.readOnly,
  }), [config, source.config, source.readOnly]);
  useLayoutEffect(() => {
    for (const id of tree.byId.keys()) if (!known.current.has(id)) undo.handleNodeInsert(id);
    known.current = new Set(tree.byId.keys());
    focus.syncTree(tree, (componentId, data) => { void source.mutations.saveYjsState({ componentId, data }); });
  }, [tree, focus, undo, source.mutations]);
  if (mergedConfig.readOnly) return <div data-selection-surface><BlockView tree={tree} config={mergedConfig} /></div>;
  return <PulpProvider tree={tree} config={mergedConfig} mutations={mutations}>
    <SurfaceFocusProvider coordinator={focus}>
      <SurfaceUndoProvider coordinator={undo}><BlockEditor /></SurfaceUndoProvider>
    </SurfaceFocusProvider>
  </PulpProvider>;
}
