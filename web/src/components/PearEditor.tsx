"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useCreateBlockNote,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useTheme } from "next-themes";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { useSpacetimeDB } from "spacetimedb/react";
import { BlockNoteSchema, defaultBlockSpecs, createCodeBlockSpec } from "@blocknote/core";
import { useSaveYjsState, useTakeSnapshotWithContent, useCreatePage } from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import { SpacetimeYjsProvider } from "@/src/lib/SpacetimeYjsProvider";
import { PageLinkBlockSpec } from "@/src/components/PageLinkBlock";
import { ImageBlockSpec } from "@/src/components/ImageBlock";
import { useCreateAttachment } from "@/src/hooks/usePages";
import { idbNamespace } from "@/src/lib/spacetime";

/** How often (ms) we push a full Yjs state blob to SpacetimeDB. */
const SAVE_INTERVAL_MS = 30_000;
/** How often (ms) we create a PageSnapshot for version history. */
const PERIODIC_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

interface PearEditorProps {
  pageId: bigint;
  /** Legacy BlockNote JSON — used only on first open if IndexedDB is empty and
   *  SpacetimeDB has no Yjs state yet. */
  initialContent: string;
  /** Child pages to auto-insert as moveable page-link blocks on first load. */
  childPages?: PageRow[];
}

export function PearEditor({ pageId, initialContent, childPages }: PearEditorProps) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { isActive } = useSpacetimeDB();
  const spacetime = useSpacetimeDB();

  const saveYjsState = useSaveYjsState();
  const takeSnapshotWithContent = useTakeSnapshotWithContent();
  const createPage = useCreatePage();
  const createAttachment = useCreateAttachment();

  // Stable refs so effects always see the latest reducer function without
  // having to re-subscribe.
  const saveRef = useRef(saveYjsState);
  saveRef.current = saveYjsState;
  const snapshotRef = useRef(takeSnapshotWithContent);
  snapshotRef.current = takeSnapshotWithContent;

  // Tracks whether we've already bootstrapped from SpacetimeDB on this mount.
  const bootstrappedRef = useRef(false);
  // Tracks whether legacy JSON migration has been attempted.
  const migratedRef = useRef(false);
  // Tracks last content saved as a snapshot (to skip unchanged periodic saves).
  const lastSnapshotContentRef = useRef<string | null>(null);
  // Tracks which child page IDs we've already auto-inserted as pageLink blocks.
  const autoInsertedRef = useRef(new Set<string>());
  // Tracks the previous set of child page IDs so we can detect removals.
  const prevChildIdsRef = useRef<Set<string> | null>(null);

  // One Y.Doc + provider per pageId (parent uses key={pageId} to fully remount).
  const docRef = useRef(new Y.Doc());
  const providerRef = useRef(new SpacetimeYjsProvider(docRef.current));

  // IndexedDB persistence: restores Y.Doc from local cache instantly before
  // SpacetimeDB subscription lands. Eliminates content pop-in on navigation.
  // The key is namespaced by server URI + database name so caches from
  // different SpacetimeDB servers never bleed into each other.
  const idbRef = useRef(
    new IndexeddbPersistence(`${idbNamespace}-page-${pageId}`, docRef.current)
  );

  // Schema is built once on the client (useMemo avoids module-level init which
  // fails in Next.js SSR because ProseMirror needs browser APIs).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const schema = useMemo(
    () =>
      BlockNoteSchema.create({
        blockSpecs: {
          ...defaultBlockSpecs,
          codeBlock: createCodeBlockSpec({
            defaultLanguage: "plain",
            supportedLanguages: {
              plain: { name: "Plain", aliases: ["text"] },
              typescript: { name: "TypeScript", aliases: ["ts"] },
              javascript: { name: "JavaScript", aliases: ["js"] },
              json: { name: "JSON" },
              html: { name: "HTML" },
              css: { name: "CSS" },
              markdown: { name: "Markdown", aliases: ["md"] },
              python: { name: "Python", aliases: ["py"] },
              bash: { name: "Bash", aliases: ["sh", "shell"] },
              sql: { name: "SQL" },
            },
          }),
          pageLink: PageLinkBlockSpec(),
          image: ImageBlockSpec(),
        },
      }),
    []
  );

  const editor = useCreateBlockNote({
    schema,
    collaboration: {
      provider: providerRef.current,
      fragment: docRef.current.getXmlFragment("document-store"),
      user: { name: "User", color: "#7b68ee" },
    },
  });

  // ── Guard against stale IDB cursor positions ─────────────────────────────
  //
  // y-indexeddb stores relative ProseMirror selections alongside Yjs updates.
  // After a server update or schema change the stored position can point past
  // the end of the document, causing an unhandled "RangeError: Position N out
  // of range" from inside the y-prosemirror sync plugin. We catch it here,
  // clear the IDB for this page so the stale selection is gone, and let
  // SpacetimeDB repopulate the content on the next mount.
  useEffect(() => {
    const idb = idbRef.current;
    function handler(event: PromiseRejectionEvent) {
      const err = event.reason;
      if (
        err instanceof RangeError &&
        typeof err.message === "string" &&
        err.message.toLowerCase().includes("out of range")
      ) {
        event.preventDefault();
        console.warn("[PearEditor] Stale IDB cursor position detected — clearing local cache for page", pageId);
        idb.clearData();
      }
    }
    window.addEventListener("unhandledrejection", handler);
    return () => window.removeEventListener("unhandledrejection", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  // ── Bootstrap from SpacetimeDB on first connect ───────────────────────────
  //
  // Strategy:
  //   1. Wait for IndexedDB to finish its async restore (`whenSynced`). This is
  //      critical — IndexeddbPersistence loads from IDB asynchronously, so
  //      checking docIsEmpty before it finishes always sees an empty doc and
  //      causes SpacetimeDB state to be merged on top of IDB state, producing
  //      duplicate/rewritten content.
  //   2. Only after IDB is synced: if the doc is still empty, pull the
  //      PageYjsState blob from SpacetimeDB (handles new devices / fresh browsers).
  //   3. If neither source has Yjs data, fall back to legacy BlockNote JSON.
  useEffect(() => {
    if (!isActive || bootstrappedRef.current) return;
    const conn = spacetime.getConnection();
    if (!conn) return;

    // Gate on IDB sync so we don't race with its async restore.
    idbRef.current.whenSynced.then(() => {
      if (bootstrappedRef.current) return; // guard against double-run
      bootstrappedRef.current = true;

      const docIsEmpty = Y.encodeStateAsUpdate(docRef.current).length <= 2;

      if (docIsEmpty) {
        // Try SpacetimeDB's Yjs state blob first.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stateRow: { data: Uint8Array } | undefined = (conn.db as any)
          .page_yjs_state?.pageId?.find(pageId);

        if (stateRow?.data && stateRow.data.length > 2) {
          Y.applyUpdate(docRef.current, stateRow.data);
        } else if (!migratedRef.current && initialContent) {
          // Fall back to legacy BlockNote JSON (one-time migration path).
          migratedRef.current = true;
          const blocks = safeParseBlocks(initialContent);
          if (blocks?.length) {
            editor.replaceBlocks(editor.document, blocks);
          }
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, pageId]);

  // ── Periodic Yjs state save to SpacetimeDB ────────────────────────────────
  //
  // Every SAVE_INTERVAL_MS we push Y.encodeStateAsUpdate(doc) → SpacetimeDB.
  // This keeps the server in sync with local edits and serves as the
  // cross-device backup / source of truth for fresh installs.
  // We also fire on unmount (via the returned cleanup) so navigating away
  // never loses unsaved work.
  useEffect(() => {
    function doSave() {
      if (!isActive) return;
      const data = Y.encodeStateAsUpdate(docRef.current);
      if (data.length <= 2) return; // empty doc, skip
      saveRef.current({ pageId, data });
    }

    const interval = setInterval(doSave, SAVE_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      doSave(); // flush on unmount
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, pageId]);

  // ── Periodic snapshot for version history ─────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const blocks = editor.document;
      if (!blocks?.length) return;
      const content = JSON.stringify(blocks);
      if (content === lastSnapshotContentRef.current) return;
      lastSnapshotContentRef.current = content;
      snapshotRef.current({
        pageId,
        snapshotType: { tag: "Periodic" },
        content,
      });
    }, PERIODIC_SNAPSHOT_INTERVAL_MS);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  // ── Auto-insert child pages as moveable pageLink blocks ──────────────────
  useEffect(() => {
    if (!isActive || !childPages?.length) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inEditor = new Set(
      (editor.document as any[])
        .filter((b) => b.type === "pageLink")
        .map((b) => b.props?.pageId as string)
    );

    const toInsert = childPages.filter((p) => {
      const id = String(p.id);
      return !inEditor.has(id) && !autoInsertedRef.current.has(id);
    });

    if (!toInsert.length) return;

    toInsert.forEach((p) => autoInsertedRef.current.add(String(p.id)));

    const blocks = editor.document;
    const lastBlock = blocks[blocks.length - 1];
    if (!lastBlock) return;

    editor.insertBlocks(
      toInsert
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((p) => ({
          type: "pageLink" as const,
          props: { pageId: String(p.id), pageTitle: p.title || "Untitled" },
        })),
      lastBlock,
      "after"
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, childPages]);

  // ── Remove pageLink blocks when their child page disappears ──────────────
  //
  // When a child page is deleted or moved to a different parent it vanishes
  // from the `childPages` prop. We remove the corresponding pageLink block so
  // the document doesn't silently keep stale / broken references.
  //
  // We skip the very first render (prevChildIdsRef is null) so we don't
  // spuriously remove blocks before the initial set of children is known.
  useEffect(() => {
    if (!isActive || !childPages) return;

    const currentIds = new Set(childPages.map((p) => String(p.id)));
    const prev = prevChildIdsRef.current;

    if (prev === null) {
      // First time — just record the baseline; nothing to remove yet.
      prevChildIdsRef.current = currentIds;
      return;
    }

    const removedIds = [...prev].filter((id) => !currentIds.has(id));
    prevChildIdsRef.current = currentIds;

    if (removedIds.length === 0) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocksToRemove = (editor.document as any[]).filter(
      (b) =>
        b.type === "pageLink" &&
        removedIds.includes(b.props?.pageId as string)
    );

    if (blocksToRemove.length > 0) {
      editor.removeBlocks(blocksToRemove);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, childPages]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    const provider = providerRef.current;
    const idb = idbRef.current;
    const doc = docRef.current;
    return () => {
      provider.destroy();
      idb.destroy();
      doc.destroy();
    };
  }, []);

  const bnTheme = !mounted || resolvedTheme === "dark" ? "dark" : "light";

  const [uploading, setUploading] = useState(false);
  const editorWrapRef = useRef<HTMLDivElement>(null);

  // Cmd+Shift+C / Ctrl+Shift+C: copy code block content to clipboard
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "c" || !e.shiftKey || (!e.metaKey && !e.ctrlKey)) return;
      if (!editorWrapRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      try {
        const pos = editor.getTextCursorPosition();
        if (pos.block.type !== "codeBlock") return;
        const text = getCodeBlockText(pos.block.content);
        if (text) void navigator.clipboard.writeText(text);
      } catch {
        // noop
      }
    }
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [editor]);

  function getCodeBlockText(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content
      .map((node: { text?: string; content?: unknown }) => {
        if (typeof node?.text === "string") return node.text;
        if (Array.isArray(node?.content)) return getCodeBlockText(node.content);
        return "";
      })
      .join("");
  }

  async function handleImageFiles(files: FileList | null) {
    if (!files?.length) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;

    setUploading(true);
    try {
      const cursorBlock = editor.getTextCursorPosition().block;
      const blocksToInsert: Array<{ type: "image"; props: { storageKey: string; caption: string } }> = [];

      for (const file of images) {
        const res = await fetch("/api/upload/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pageId: String(pageId),
            filename: file.name || "image",
            contentType: file.type || "image/png",
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          console.error("[PearEditor] upload request failed", err);
          continue;
        }
        const { uploadUrl, storageKey } = await res.json();
        const putRes = await fetch(uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "image/png" },
        });
        if (!putRes.ok) {
          console.error("[PearEditor] upload PUT failed");
          continue;
        }
        createAttachment({
          pageId,
          filename: file.name || "image",
          contentType: file.type || "image/png",
          storageKey,
          sizeBytes: BigInt(file.size),
        });
        blocksToInsert.push({ type: "image", props: { storageKey, caption: "" } });
      }

      if (blocksToInsert.length > 0) {
        editor.insertBlocks(blocksToInsert, cursorBlock, "after");
      }
    } finally {
      setUploading(false);
    }
  }

  function onPasteOrDrop(e: React.ClipboardEvent | React.DragEvent) {
    const files = "clipboardData" in e ? e.clipboardData?.files : e.dataTransfer?.files;
    const images = files ? Array.from(files).filter((f) => f.type.startsWith("image/")) : [];
    if (images.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      handleImageFiles(files!);
    }
  }

  const fileInputRef = useRef<HTMLInputElement>(null);

  const imageSlashItem = {
    title: "Image",
    subtext: "Upload an image",
    aliases: ["img", "photo", "picture"],
    group: "Upload",
    onItemClick: () => fileInputRef.current?.click(),
  };

  // Build the "New Page" slash menu item. Defined inside the component so it
  // closes over editor, pageId, createPage, spacetime, and autoInsertedRef.
  const newPageSlashItem = {
    title: "New Page",
    subtext: "Create a subpage linked here",
    aliases: ["page", "subpage", "child", "link"],
    group: "Pages",
    onItemClick: () => {
      const conn = spacetime.getConnection();
      if (!conn) return;

      // Snapshot the cursor position now — before the async gap.
      const cursorBlock = editor.getTextCursorPosition().block;

      // Known child page IDs before this operation so we can identify the new one.
      const knownChildIds = new Set(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Array.from((conn.db as any).page?.iter?.() ?? [])
          .filter((p: any) => p.parentId === pageId && p.deletedAt == null)
          .map((p: any) => p.id as bigint)
      );

      // One-time listener: fires when SpacetimeDB confirms the new page row.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const onInsert = (_ctx: any, newPage: any) => {
        if (newPage.parentId !== pageId) return;
        if (knownChildIds.has(newPage.id)) return;

        // Prevent autoInsert effect from also inserting this block.
        autoInsertedRef.current.add(String(newPage.id));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (conn.db as any).page?.removeOnInsert(onInsert);

        editor.insertBlocks(
          [{ type: "pageLink" as const, props: { pageId: String(newPage.id), pageTitle: newPage.title || "Untitled" } }],
          cursorBlock,
          "after"
        );
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (conn.db as any).page?.onInsert(onInsert);

      createPage({ parentId: pageId, pageType: { tag: "Doc" }, title: "Untitled" });
    },
  };

  return (
    <div
      ref={editorWrapRef}
      className="prose max-w-none dark:prose-invert relative"
      onPaste={onPasteOrDrop}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
      }}
      onDrop={onPasteOrDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          handleImageFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {uploading && (
        <div className="absolute top-2 right-2 z-10 px-2 py-1 rounded bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 text-xs font-medium">
          Uploading…
        </div>
      )}
      <BlockNoteView editor={editor} theme={bnTheme} slashMenu={false}>
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query: string) => {
            const defaults = getDefaultReactSlashMenuItems(editor);
            const withoutDefaultImage = defaults.filter(
              (item) => item.title !== "Image"
            );
            const all = [
              ...withoutDefaultImage,
              imageSlashItem,
              newPageSlashItem,
            ];
            if (!query) return all;
            const q = query.toLowerCase();
            return all.filter(
              (item) =>
                item.title.toLowerCase().includes(q) ||
                item.aliases?.some((a) => a.toLowerCase().includes(q))
            );
          }}
        />
      </BlockNoteView>
    </div>
  );
}

function safeParseBlocks(content: string) {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}
