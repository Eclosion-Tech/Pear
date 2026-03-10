"use client";

import { useEffect, useRef, useState } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useTheme } from "next-themes";
import * as Y from "yjs";
import { useSpacetimeDB } from "spacetimedb/react";
import { useApplyYjsUpdate, useTakeSnapshotWithContent } from "@/src/hooks/usePages";
import { SpacetimeYjsProvider } from "@/src/lib/SpacetimeYjsProvider";

const PERIODIC_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface PearEditorProps {
  pageId: bigint;
  /** Legacy BlockNote JSON — used only on first open if no Yjs history exists. */
  initialContent: string;
}

export function PearEditor({ pageId, initialContent }: PearEditorProps) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // isActive tells us when the SpacetimeDB subscription snapshot has landed.
  const { isActive } = useSpacetimeDB();
  const spacetime = useSpacetimeDB();

  const applyYjsUpdate = useApplyYjsUpdate();
  const takeSnapshotWithContent = useTakeSnapshotWithContent();

  // Keep reducer references stable inside callbacks/provider.
  const applyRef = useRef(applyYjsUpdate);
  applyRef.current = applyYjsUpdate;
  const snapshotRef = useRef(takeSnapshotWithContent);
  snapshotRef.current = takeSnapshotWithContent;

  const lastSnapshotContentRef = useRef<string | null>(null);
  const migratedRef = useRef(false);
  // Persists across isActive changes so we never re-apply the same Yjs update
  // twice to the Y.Doc. Without this, every disconnect/reconnect would
  // re-apply the full history → unbounded memory growth → OOM.
  const appliedIdsRef = useRef(new Set<bigint>());

  // One Y.Doc + provider per pageId (parent uses key={pageId} so this
  // component fully remounts on page change).
  const docRef = useRef(new Y.Doc());
  const providerRef = useRef(
    new SpacetimeYjsProvider(docRef.current, (data) =>
      applyRef.current({ pageId, data })
    )
  );

  const editor = useCreateBlockNote({
    collaboration: {
      provider: providerRef.current,
      fragment: docRef.current.getXmlFragment("document-store"),
      user: {
        name: "User",
        color: "#7b68ee",
      },
    },
  });

  // ── Subscribe to Yjs updates WITHOUT React state ──────────────────────────
  //
  // The old approach used useTable(page_yjs_update) which is React state.
  // Every incoming update (including echoes of our own keystrokes) caused a
  // React re-render → BlockNote reconciled the full editor tree → sluggish
  // with deep nesting.
  //
  // New approach: use the SDK's onInsert callback directly. Updates are
  // applied to the Y.Doc in the event handler with no React involvement,
  // so keystrokes never trigger a component re-render.
  useEffect(() => {
    if (!isActive) return;
    const conn = spacetime.getConnection();
    if (!conn) return;

    // Reuse the persistent set — never re-apply an update we've already
    // sent to the Y.Doc, even if isActive toggles or the component re-renders.
    const applied = appliedIdsRef.current;

    // 1. Apply historical rows we haven't seen yet (skips already-applied ones
    //    on reconnect so the Y.Doc doesn't balloon with duplicate processing).
    const existing = Array.from(conn.db.page_yjs_update.iter())
      .filter((u) => u.pageId === pageId && !applied.has(u.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const u of existing) {
      applied.add(u.id);
      providerRef.current.applyUpdate(u.data);
    }

    // 2. Migrate from legacy PageContent JSON if no Yjs history exists at all.
    if (!migratedRef.current) {
      migratedRef.current = true;
      if (applied.size === 0 && initialContent) {
        const blocks = safeParseBlocks(initialContent);
        if (blocks?.length) {
          providerRef.current.paused = true;
          editor.replaceBlocks(editor.document, blocks);
          const snapshot = Y.encodeStateAsUpdate(docRef.current);
          providerRef.current.paused = false;
          applyRef.current({ pageId, data: snapshot });
        }
      }
    }

    // 3. Subscribe to live inserts — no React state, no re-renders.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onInsert = (_ctx: any, row: { id: bigint; pageId: bigint; data: Uint8Array }) => {
      if (row.pageId !== pageId) return;
      if (applied.has(row.id)) return;
      applied.add(row.id);
      providerRef.current.applyUpdate(row.data);
    };

    conn.db.page_yjs_update.onInsert(onInsert);
    return () => {
      conn.db.page_yjs_update.removeOnInsert(onInsert);
    };
  // editor is a stable ref created once. initialContent is read once for
  // migration and intentionally not a dep (would re-run on every render).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, pageId]);

  // ── Periodic snapshot every 5 minutes while the editor is open ───────────
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

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    const provider = providerRef.current;
    const doc = docRef.current;
    return () => {
      provider.destroy();
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
