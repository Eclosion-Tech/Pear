"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useTheme } from "next-themes";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { useSpacetimeDB } from "spacetimedb/react";
import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { useSaveYjsState, useTakeSnapshotWithContent } from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import { SpacetimeYjsProvider } from "@/src/lib/SpacetimeYjsProvider";
import { PageLinkBlockSpec } from "@/src/components/PageLinkBlock";
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
        blockSpecs: { ...defaultBlockSpecs, pageLink: PageLinkBlockSpec() },
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

  // ── Bootstrap from SpacetimeDB on first connect ───────────────────────────
  //
  // Strategy:
  //   1. IndexedDB has already restored local state (done by IndexeddbPersistence
  //      before this effect runs, because idbRef is created at ref init time).
  //   2. Once SpacetimeDB is connected (isActive), check if there's a
  //      PageYjsState blob. Apply it only if IndexedDB was empty (bootstrapped
  //      from a clean slate) — this handles new devices and fresh browsers.
  //   3. If neither IndexedDB nor SpacetimeDB has Yjs data, fall back to the
  //      legacy BlockNote JSON in initialContent.
  useEffect(() => {
    if (!isActive || bootstrappedRef.current) return;
    const conn = spacetime.getConnection();
    if (!conn) return;
    bootstrappedRef.current = true;

    const docIsEmpty = Y.encodeStateAsUpdate(docRef.current).length <= 2;

    if (docIsEmpty) {
      // Try SpacetimeDB's Yjs state blob first.
      // conn.db.page_yjs_state is the typed accessor generated from our schema.
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

    const inEditor = new Set(
      editor.document
        .filter((b) => b.type === "pageLink")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((b) => (b.props as any).pageId as string)
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

  return (
    <div className="prose max-w-none dark:prose-invert">
      <BlockNoteView editor={editor} theme={bnTheme} />
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
