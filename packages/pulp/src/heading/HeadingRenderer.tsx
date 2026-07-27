"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Y from "yjs";
import type { EditorView } from "prosemirror-view";
import { yDocToHtml } from "../rich-text/yjsToHtml";
import { RichTextEditor, type EditorSurfaceMode } from "../rich-text/RichTextEditor";
import { usePulp } from "../context/PulpProvider";
import { useSurfaceFocus } from "../focus/SurfaceFocusProvider";
import { useSurfaceSelectionOptional } from "../selection/SurfaceSelectionProvider";
import type { BlockRendererProps } from "../registry";
import type { BlockId } from "../types";
import type { FocusPlacement } from "../focus/SurfaceFocusCoordinator";
import { knownSiblingIdsForParent } from "../focus/insertFocusHelpers";
import {
  getDocumentNextBlock,
  getDocumentPrevBlock,
} from "../navigation/blockNavigation";
import {
  canNestBlock,
  canUnnestBlock,
  deleteEmptyBlockAndFocusDocumentPrev,
  mergeBlockIntoDocumentPrev,
  nestBlockUnderPreviousSibling,
  turnIntoBlock,
  unnestBlock,
} from "../blockActions";
import {
  headingPropsJson,
  normalizeTextAlign,
  plainTextToYDoc,
  type TextAlign,
} from "../rich-text/richTextFormatting";
import { SPRINT_3B_SLASH_ITEMS, type SlashMenuItem } from "../SlashMenu";
import { turnIntoToolbarItems } from "../toolbarTurnIntoItems";
import { splitEditorAtCaret } from "../rich-text/splitEditorAtCaret";
import { resolveHeadingEnter } from "./headingEnter";

type HeadingProps = {
  level?: number;
  /** Legacy v1 plain-text title — bootstrapped into Yjs once, then ignored. */
  text?: string;
  textAlign?: TextAlign;
  collapsed?: boolean;
  /** Collapsible-section heading (owns nested children). */
  section?: boolean;
};

const HEADING_STATIC_CLASS: Record<number, string> = {
  1: "text-4xl font-bold leading-tight my-2",
  2: "text-3xl font-bold leading-tight my-2",
  3: "text-2xl font-semibold leading-tight my-2",
  4: "text-xl font-semibold leading-tight my-2",
  5: "text-lg font-medium leading-tight my-2",
  6: "text-base font-medium leading-tight my-2",
};

/**
 * Public `Heading` renderer — a thin dispatcher. In read-only mode
 * (`config.readOnly`, set by `<BlockView>`) it renders a static heading with
 * no editor machinery; otherwise the full editable renderer.
 */
export function HeadingRenderer(props: BlockRendererProps) {
  const { config } = usePulp();
  if (config.readOnly) return <StaticHeading {...props} />;
  return <EditableHeading {...props} />;
}

/**
 * Read-only Heading — static HTML from the Yjs blob, non-interactive section
 * chevron, children rendered when expanded. No ProseMirror / IndexedDB / focus.
 */
function StaticHeading({ node, tree, children }: BlockRendererProps) {
  const props = useMemo<HeadingProps>(() => safeParse(node.props), [node.props]);
  const level = clampLevel(props.level);
  const textAlign = normalizeTextAlign(props.textAlign);
  const collapsed = props.collapsed ?? false;
  const sectionFlag = props.section === true;
  const legacyText = props.text ?? "";

  const sectionChildren = tree.byParent.get(node.id) ?? [];
  const hasSection = sectionFlag || sectionChildren.length > 0;

  const state = tree.yjs.get(node.id);
  const html = useMemo(() => {
    if (!state?.data || state.data.byteLength === 0) {
      return legacyText ? escapeHtml(legacyText) : "";
    }
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state.data, "remote");
      return yDocToHtml(doc);
    } catch {
      return "";
    } finally {
      doc.destroy();
    }
  }, [state?.data, legacyText]);

  const alignStyle =
    textAlign === "left" ? undefined : ({ textAlign } as const);

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-start gap-1">
        {hasSection ? (
          <span
            className="mt-2 flex h-6 w-6 shrink-0 items-center justify-center text-neutral-400 dark:text-neutral-500"
            aria-hidden
          >
            <ChevronIcon collapsed={collapsed} />
          </span>
        ) : (
          <span className="w-6 shrink-0" aria-hidden />
        )}
        <div className="min-h-[1.5em] min-w-0 flex-1" style={alignStyle}>
          <div
            className={`${HEADING_STATIC_CLASS[level]} text-neutral-900 dark:text-neutral-100 [&_p]:my-0`}
            dangerouslySetInnerHTML={{
              __html:
                html || `<p class="italic text-neutral-400">Heading ${level}</p>`,
            }}
          />
        </div>
      </div>
      {hasSection && !collapsed ? (
        <div className="ml-7 border-l border-neutral-200 pl-3 dark:border-neutral-700">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function EditableHeading({ node, tree, children }: BlockRendererProps) {
  const props = useMemo<HeadingProps>(() => safeParse(node.props), [node.props]);
  const level = clampLevel(props.level);
  const textAlign = normalizeTextAlign(props.textAlign);
  const collapsed = props.collapsed ?? false;
  const legacyText = props.text ?? "";
  const sectionFlag = props.section === true;

  const sectionChildren = tree.byParent.get(node.id) ?? [];
  // Render as a section when explicitly flagged OR while it owns children.
  const hasSection = sectionFlag || sectionChildren.length > 0;

  const state = tree.yjs.get(node.id);
  const { insertBlock, deleteBlock, moveBlock, saveYjsState, config, updateBlockProps } =
    usePulp();
  const focus = useSurfaceFocus();
  const selection = useSurfaceSelectionOptional();
  const suppressSaveRef = useRef(false);
  const editorApplyFocusRef = useRef<((placement: FocusPlacement) => void) | null>(
    null,
  );
  const pendingFocusRef = useRef<FocusPlacement | null>(null);
  const bootstrappedLegacyRef = useRef(false);
  const textAlignRef = useRef(textAlign);
  textAlignRef.current = textAlign;

  const removeSelf = () => {
    suppressSaveRef.current = true;
    deleteBlock({ componentId: node.id });
  };

  const surfaceMode: EditorSurfaceMode = useMemo(
    () => ({ kind: "heading", level }),
    [level],
  );

  const [{ doc }] = useState(() => {
    const initial = focus.consumeInitialDoc(node.id);
    return { doc: initial ?? new Y.Doc() };
  });

  useLayoutEffect(() => {
    const initial = focus.consumeInitialDoc(node.id);
    if (initial) {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(initial), "remote");
    }
  }, [doc, focus, node.id]);

  const lastAppliedAtRef = useRef<bigint | null>(null);
  useEffect(() => {
    if (!state?.data || state.data.byteLength === 0) return;
    const stateStamp = state.updatedAt?.microsSinceUnixEpoch ?? null;
    if (stateStamp != null && lastAppliedAtRef.current === stateStamp) return;
    try {
      Y.applyUpdate(doc, state.data, "remote");
      lastAppliedAtRef.current = stateStamp;
    } catch (err) {
      console.warn(`[HeadingRenderer] failed to apply Yjs for ${node.id}:`, err);
    }
  }, [doc, node.id, state?.data, state?.updatedAt?.microsSinceUnixEpoch]);

  useEffect(() => {
    if (bootstrappedLegacyRef.current) return;
    if (state?.data && state.data.byteLength > 0) return;
    if (!legacyText) return;
    bootstrappedLegacyRef.current = true;
    const initial = plainTextToYDoc(legacyText);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(initial), "local");
    saveYjsState({
      componentId: node.id,
      data: Y.encodeStateAsUpdate(doc),
    });
  }, [doc, legacyText, node.id, saveYjsState, state?.data]);

  useEffect(() => () => doc.destroy(), [doc]);

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

  const bindFocus = useCallback((applyFocus: (placement: FocusPlacement) => void) => {
    editorApplyFocusRef.current = applyFocus;
    if (pendingFocusRef.current) {
      applyFocus(pendingFocusRef.current);
      pendingFocusRef.current = null;
    }
    return () => {
      editorApplyFocusRef.current = null;
    };
  }, []);

  const claimInsertFocus = useCallback((): FocusPlacement | null => {
    return (
      focus.matchPendingInsert(node.id, tree, (componentId, data) =>
        saveYjsState({ componentId, data }),
      ) ?? focus.claimFocus(node.id)
    );
  }, [focus, node.id, tree, saveYjsState]);

  const onSplit = useCallback(
    (view: EditorView): boolean => {
      const action = resolveHeadingEnter(tree, node);
      if (!action) return false;

      // Split the title at the caret — prefix stays in the heading, suffix
      // (marks carried) seeds the new RichText. At-end is an empty suffix.
      const initialDoc = splitEditorAtCaret(view);
      if (!initialDoc) return false;

      if (action.kind === "prepend-section") {
        // New body paragraph at the top of the section.
        focus.armForInsert(action.headingId, undefined, {
          initialDoc,
          focusAt: "start",
          knownSiblingIds: knownSiblingIdsForParent(tree, action.headingId),
        });
        insertBlock({
          parentId: action.headingId,
          componentType: "RichText",
          propsJson: "{}",
        });
        return true;
      }

      focus.armForInsert(action.parentId, action.afterSiblingId, {
        initialDoc,
        focusAt: "start",
        knownSiblingIds: knownSiblingIdsForParent(tree, action.parentId),
      });
      insertBlock({
        parentId: action.parentId,
        componentType: "RichText",
        propsJson: "{}",
        afterSiblingId: action.afterSiblingId,
      });
      return true;
    },
    [tree, node, focus, insertBlock],
  );

  const siblings = node.parentId != null ? tree.byParent.get(node.parentId) ?? [] : [];
  const canDelete = siblings.length > 1;

  const onIndent = useCallback(
    (): boolean =>
      nestBlockUnderPreviousSibling(node, tree, { moveBlock }, focus),
    [node, tree, moveBlock, focus],
  );

  const onOutdent = useCallback(
    (): boolean => unnestBlock(node, tree, { moveBlock }, focus),
    [node, tree, moveBlock, focus],
  );

  const turnIntoItems = useMemo(
    () => turnIntoToolbarItems(config.slashItems ?? SPRINT_3B_SLASH_ITEMS, tree.defs),
    [config.slashItems, tree.defs],
  );

  const onTextAlignChange = useCallback(
    (align: TextAlign) => {
      textAlignRef.current = align;
      updateBlockProps({
        componentId: node.id,
        propsJson: headingPropsJson(level, {
          textAlign: align,
          collapsed,
          section: sectionFlag,
        }),
      });
    },
    [collapsed, level, node.id, sectionFlag, updateBlockProps],
  );

  const blockActions = useMemo(
    () => ({
      componentType: node.componentType,
      propsJson: node.props,
      canNest: canNestBlock(node, tree),
      canUnnest: canUnnestBlock(node, tree),
      turnIntoItems,
      textAlign,
      onTextAlignChange,
      onTurnInto: (item: SlashMenuItem) => {
        turnIntoBlock(
          node,
          tree,
          item,
          { insertBlock, deleteBlock, moveBlock, updateBlockProps, saveYjsState },
          focus,
        );
      },
      onNest: () => onIndent(),
      onOutdent: () => onOutdent(),
    }),
    [
      node,
      tree,
      turnIntoItems,
      textAlign,
      onTextAlignChange,
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

  const onDeleteSelf = useCallback(() => {
    suppressSaveRef.current = true;
    deleteEmptyBlockAndFocusDocumentPrev(node, tree, focus, {
      deleteBlock,
      moveBlock,
    });
  }, [node, tree, focus, deleteBlock, moveBlock]);

  const canBackspaceDeleteEmpty =
    getDocumentPrevBlock(tree, node.id) != null || canDelete;

  const onMergeWithPrev = useCallback(
    (view: EditorView): boolean => {
      suppressSaveRef.current = true;
      return mergeBlockIntoDocumentPrev(
        node,
        view,
        tree,
        focus,
        { saveYjsState, moveBlock },
        removeSelf,
      );
    },
    [node, tree, focus, saveYjsState, moveBlock],
  );

  const onEscape = useCallback((): boolean => {
    if (!selection) return false;
    selection.controller.selectOnly(node.id);
    focus.getEditor(node.id)?.dom.blur();
    return true;
  }, [selection, node.id, focus]);

  const toggleCollapsed = () => {
    updateBlockProps({
      componentId: node.id,
      propsJson: headingPropsJson(level, {
        textAlign,
        collapsed: !collapsed,
        section: sectionFlag,
      }),
    });
  };

  // Promote to an explicit section once the heading owns children, so the
  // toggle persists even if the children are later removed (Notion's
  // toggle-heading semantics). Idempotent — the condition clears after write.
  useEffect(() => {
    if (sectionFlag || sectionChildren.length === 0) return;
    updateBlockProps({
      componentId: node.id,
      propsJson: headingPropsJson(level, {
        textAlign,
        collapsed,
        section: true,
      }),
    });
  }, [
    sectionFlag,
    sectionChildren.length,
    level,
    textAlign,
    collapsed,
    node.id,
    updateBlockProps,
  ]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [inViewport, setInViewport] = useState(true);
  const [hasFocus, setHasFocus] = useState(false);

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

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
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

  const live = inViewport || hasFocus;
  // Static-mode HTML — only maintained while static; live mode renders
  // ProseMirror and never reads `html`, so a per-keystroke serialization
  // would be wasted work. See the matching comment in RichText.tsx.
  const [html, setHtml] = useState("");
  useEffect(() => {
    if (live) return;
    const update = () => setHtml(yDocToHtml(doc));
    update(); // catch edits made while live (incl. the live→static flip)
    doc.on("update", update);
    return () => doc.off("update", update);
  }, [doc, live]);

  const alignStyle =
    textAlign === "left" ? undefined : ({ textAlign } as const);

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-start gap-1">
        {hasSection ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand section" : "Collapse section"}
            onClick={toggleCollapsed}
            className="mt-2 flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <ChevronIcon collapsed={collapsed} />
          </button>
        ) : (
          <span className="w-6 shrink-0" aria-hidden />
        )}
        <div
          ref={hostRef}
          className="min-h-[1.5em] min-w-0 flex-1"
          style={alignStyle}
        >
          {live ? (
            <RichTextEditor
              doc={doc}
              componentId={node.id}
              placeholder={`Heading ${level}`}
              surfaceMode={surfaceMode}
              shouldClaimFocus={claimInsertFocus}
              onFocus={() => setHasFocus(true)}
              onBlur={() => setHasFocus(false)}
              onSplit={onSplit}
              onDeleteSelf={canBackspaceDeleteEmpty ? onDeleteSelf : undefined}
              onMergeWithPrev={onMergeWithPrev}
              suppressSaveRef={suppressSaveRef}
              onNavigatePrev={onNavigatePrev}
              onNavigateNext={onNavigateNext}
              onIndent={onIndent}
              onOutdent={onOutdent}
              bindFocus={bindFocus}
              blockActions={blockActions}
              onEscape={onEscape}
            />
          ) : (
            <div
              className={`${HEADING_STATIC_CLASS[level]} text-neutral-900 dark:text-neutral-100 [&_p]:my-0`}
              dangerouslySetInnerHTML={{
                __html: html || `<p class="italic text-neutral-400">Heading ${level}</p>`,
              }}
            />
          )}
        </div>
      </div>
      {hasSection && !collapsed ? (
        <div className="ml-7 border-l border-neutral-200 pl-3 dark:border-neutral-700">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function clampLevel(raw: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > 6) return 6;
  return Math.floor(n) as 1 | 2 | 3 | 4 | 5 | 6;
}

function safeParse(s: string): HeadingProps {
  try {
    return JSON.parse(s) as HeadingProps;
  } catch {
    return {};
  }
}

/** Escape a legacy plain-text title for static (read-only) rendering. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
