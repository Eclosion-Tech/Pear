"use client";

import { useEffect, useRef, useState } from "react";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useTheme } from "next-themes";
import * as Y from "yjs";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { useApplyYjsUpdate } from "@/src/hooks/usePages";
import { SpacetimeYjsProvider } from "@/src/lib/SpacetimeYjsProvider";

interface PearEditorProps {
  pageId: bigint;
  /** Legacy BlockNote JSON — used only on first open if no Yjs history exists. */
  initialContent: string;
}

export function PearEditor({ pageId, initialContent }: PearEditorProps) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const applyYjsUpdate = useApplyYjsUpdate();
  // Keep reducer reference stable inside callbacks/provider without
  // recreating the provider on every render.
  const applyRef = useRef(applyYjsUpdate);
  applyRef.current = applyYjsUpdate;

  // One Y.Doc + provider per pageId (parent uses key={pageId} so this
  // component fully remounts on page change).
  const docRef = useRef(new Y.Doc());
  const providerRef = useRef(
    new SpacetimeYjsProvider(docRef.current, (data) =>
      applyRef.current({ pageId, data })
    )
  );

  // Track which update IDs have already been applied to the local doc.
  const appliedIdsRef = useRef(new Set<bigint>());
  // Ensures legacy-content migration runs exactly once.
  const migratedRef = useRef(false);

  // Subscribe to Yjs updates from SpacetimeDB.
  // subscribeToAllTables() in spacetime.ts means this table is already
  // included; isReady signals the initial snapshot has landed.
  const [allYjsUpdates, yjsReady] = useTable(tables.page_yjs_update);

  // ── Create the collaborative BlockNote editor ────────────────────────────
  // The editor is stable for the lifetime of this component (remounted via
  // key={pageId} in the parent when the active page changes).
  const editor = useCreateBlockNote({
    collaboration: {
      provider: providerRef.current,
      fragment: docRef.current.getXmlFragment("document-store"),
      user: {
        // TODO: replace with actual user name/colour from auth context
        name: "User",
        color: "#7b68ee",
      },
    },
  });

  // ── Apply incoming updates + migrate legacy content ───────────────────────
  useEffect(() => {
    const pageUpdates = allYjsUpdates
      .filter((u) => u.pageId === pageId)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // Apply any updates not yet seen (handles both initial load and live
    // updates from other clients arriving after mount).
    for (const u of pageUpdates) {
      if (!appliedIdsRef.current.has(u.id)) {
        appliedIdsRef.current.add(u.id);
        providerRef.current.applyUpdate(u.data);
      }
    }

    // Once the subscription is ready, decide whether to migrate legacy content.
    if (!yjsReady || migratedRef.current) return;

    if (pageUpdates.length > 0) {
      // Yjs history exists — nothing to migrate.
      migratedRef.current = true;
      return;
    }

    // No Yjs history yet: bootstrap from the legacy page_content JSON.
    // Pause outgoing updates, apply all blocks in one go, then encode the
    // full state as a single consolidated Yjs update to send to SpacetimeDB.
    migratedRef.current = true;
    if (!initialContent) return;

    const blocks = safeParseBlocks(initialContent);
    if (!blocks?.length) return;

    providerRef.current.paused = true;
    editor.replaceBlocks(editor.document, blocks);
    const snapshot = Y.encodeStateAsUpdate(docRef.current);
    providerRef.current.paused = false;
    applyRef.current({ pageId, data: snapshot });
  // editor and applyRef.current are stable refs — intentionally omitted from
  // deps to prevent the effect from re-running on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allYjsUpdates, yjsReady, pageId]);

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
