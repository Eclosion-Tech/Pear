"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  useSaveYjsState,
  useTakeSnapshotWithContent,
  useCreatePage,
  usePages,
  useSetPageEmbedding,
} from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import { useCreateJob } from "@/src/hooks/useOrcha";
import { useAiUserProfiles } from "@/src/hooks/useAiUsers";
import { useUsers } from "@/src/hooks/useUser";
import { useCreateConversation, useConversationsForPage } from "@/src/hooks/useConversations";
import { SpacetimeYjsProvider } from "@/src/lib/SpacetimeYjsProvider";
import { PageLinkBlockSpec } from "@/src/components/PageLinkBlock";
import { ImageBlockSpec } from "@/src/components/ImageBlock";
import { AudioBlockSpec } from "@/src/components/AudioBlock";
import { AudioAttachmentContext } from "@/src/components/AudioAttachmentContext";
import { MeetingNotesBanner } from "@/src/components/MeetingNotesBanner";
import {
  useMeetingCallDetection,
  readMeetingBannerDismissedSession,
  setMeetingBannerDismissedSession,
} from "@/src/hooks/useMeetingCallDetection";
import { useCreateAttachment } from "@/src/hooks/usePages";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { uploadWorkspaceBlob } from "@/src/lib/blobUpload";

/** How often (ms) we push a full Yjs state blob to SpacetimeDB. */
const SAVE_INTERVAL_MS = 30_000;

/**
 * BlockNote's SuggestionMenu uses `key={item.title}` — duplicate titles break
 * React reconciliation and can look like "accumulating" rows. Defaults also
 * carry a stable `key` (e.g. "image"); we dedupe by key or title+subtext.
 */
function dedupePearSlashItems<
  T extends { title: string; subtext?: string; key?: string },
>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k =
      (item as { key?: string }).key ??
      `${item.title}::${item.subtext ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
/** How often (ms) we create a PageSnapshot for version history. */
const PERIODIC_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;



interface PearEditorProps {
  pageId: bigint;
  /** Legacy BlockNote JSON — used only on first open if IndexedDB is empty and
   *  SpacetimeDB has no Yjs state yet. */
  initialContent: string;
  /** Child pages to auto-insert as moveable page-link blocks on first load. */
  childPages?: PageRow[];
  /** Called when the user @mentions an AI user, so the parent can open the AI panel. */
  onMentionAiUser?: () => void;
}

export function PearEditor({ pageId, initialContent, childPages, onMentionAiUser }: PearEditorProps) {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { idbNamespace, activeWorkspace } = useWorkspace();
  const workspaceSlug = activeWorkspace?.dbName ?? "";
  const { isActive, identity } = useSpacetimeDB();
  const spacetime = useSpacetimeDB();

  const saveYjsState = useSaveYjsState();
  const takeSnapshotWithContent = useTakeSnapshotWithContent();
  const setPageEmbedding = useSetPageEmbedding();
  const { pages: allPages } = usePages();
  const createPage = useCreatePage();
  const createAttachment = useCreateAttachment();
  const createJob = useCreateJob();

  const { profiles: aiUsers } = useAiUserProfiles();
  const { users: workspaceUsers } = useUsers();
  const createConversation = useCreateConversation();
  const { conversations } = useConversationsForPage(pageId);

  const [aiPromptOpen, setAiPromptOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiSubmitting, setAiSubmitting] = useState(false);

  const {
    detected: meetingLikely,
    needsPermissionHint,
    requestPermission,
    desktopTrayHint,
    clearDesktopTrayHint,
  } = useMeetingCallDetection();
  const [meetingBannerDismissed, setMeetingBannerDismissed] = useState(false);
  useEffect(() => {
    setMeetingBannerDismissed(readMeetingBannerDismissedSession());
  }, []);
  const showPermissionPrompt = needsPermissionHint && !meetingBannerDismissed;
  const showMeetingPrompt =
    (meetingLikely || desktopTrayHint) &&
    !meetingBannerDismissed &&
    !needsPermissionHint;

  // Stable refs so effects always see the latest reducer function without
  // having to re-subscribe.
  const saveRef = useRef(saveYjsState);
  saveRef.current = saveYjsState;
  const snapshotRef = useRef(takeSnapshotWithContent);
  snapshotRef.current = takeSnapshotWithContent;
  // Tracks the latest initialContent prop so event handlers can access it.
  const initialContentRef = useRef(initialContent);
  initialContentRef.current = initialContent;

  // Tracks whether we've already bootstrapped from SpacetimeDB on this mount.
  const bootstrappedRef = useRef(false);
  // Tracks whether legacy JSON migration has been attempted.
  const migratedRef = useRef(false);
  // Tracks last content saved as a snapshot (to skip unchanged periodic saves).
  const lastSnapshotContentRef = useRef<string | null>(null);
  /** FNV-1a hash of last successfully indexed text (title + markdown) for semantic search. */
  const lastEmbedHashRef = useRef<string>("");
  // Tracks which child page IDs we've already auto-inserted as pageLink blocks.
  const autoInsertedRef = useRef(new Set<string>());
  // Tracks the previous set of child page IDs so we can detect removals.
  const prevChildIdsRef = useRef<Set<string> | null>(null);
  // Stable reference to childPages — only update ref when the set of IDs changes.
  const childPagesRef = useRef(childPages);
  const childIdsKey = childPages?.map((p) => String(p.id)).sort().join(",") ?? "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useMemo(() => { childPagesRef.current = childPages; }, [childIdsKey]);

  // One Y.Doc + provider per pageId (parent uses key={pageId} to fully remount).
  const docRef = useRef(new Y.Doc());
  const providerRef = useRef(new SpacetimeYjsProvider(docRef.current));

  // IndexeddbPersistence is created in a useEffect (not useRef) so it
  // initializes AFTER the ProseMirror view is mounted. This prevents the
  // y-prosemirror sync plugin from trying to restore a cursor position
  // before the editor view has content, which causes RangeError.
  const idbRef = useRef<IndexeddbPersistence | null>(null);

  // Schema is built once per mount. We briefly patch console.warn to swallow
  // the linkifyjs "already initialized" warnings that BlockNote emits when it
  // registers URL schemes and they've already been registered by a previous
  // editor instance (happens on page navigation / key-based remounts).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const schema = useMemo(() => {
    const origWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === "string" && args[0].startsWith("linkifyjs:")) return;
      origWarn(...args);
    };
    try {
      return BlockNoteSchema.create({
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
          audio: AudioBlockSpec(),
        },
      });
    } finally {
      console.warn = origWarn;
    }
  }, []);

  const editor = useCreateBlockNote({
    schema,
    collaboration: {
      provider: providerRef.current,
      fragment: docRef.current.getXmlFragment("document-store"),
      user: { name: "User", color: "#7b68ee" },
    },
  });

  // ── Initialize IDB persistence + bootstrap from SpacetimeDB ──────────────
  //
  // IndexeddbPersistence is created here (after mount) rather than in useRef
  // so that the ProseMirror view is ready before IDB data triggers
  // restoreRelativeSelection in the y-prosemirror sync plugin.
  //
  // Bootstrap strategy:
  //   1. Wait for IDB to finish its async restore (`whenSynced`).
  //   2. Only after IDB is synced: if the doc is still empty, pull the
  //      PageYjsState blob from SpacetimeDB (handles new devices / fresh browsers).
  //   3. If neither source has Yjs data, fall back to legacy BlockNote JSON.
  useEffect(() => {
    if (idbRef.current) return; // already created
    const idb = new IndexeddbPersistence(`${idbNamespace}-page-${pageId}`, docRef.current);
    idbRef.current = idb;

    if (!isActive || bootstrappedRef.current) return;
    const conn = spacetime.getConnection();
    if (!conn) return;

    idb.whenSynced.then(() => {
      if (bootstrappedRef.current) return;
      bootstrappedRef.current = true;

      const docIsEmpty = Y.encodeStateAsUpdate(docRef.current).length <= 2;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = conn.db as any;
      const stateRow: { data: Uint8Array; updatedAt?: { microsSinceUnixEpoch: bigint } } | undefined =
        db.page_yjs_state?.pageId?.find(pageId);
      const contentRow: { updatedAt?: { microsSinceUnixEpoch: bigint } } | undefined =
        db.page_content?.pageId?.find(pageId);

      const contentIsNewerThanYjs =
        contentRow?.updatedAt &&
        stateRow?.updatedAt &&
        contentRow.updatedAt.microsSinceUnixEpoch > stateRow.updatedAt.microsSinceUnixEpoch;

      if (contentIsNewerThanYjs) {
        if (!docIsEmpty) {
          idb.clearData().catch(() => {});
        }
        migratedRef.current = true;
        const blocks = safeParseBlocks(initialContentRef.current);
        if (blocks?.length) {
          editor.replaceBlocks(editor.document, blocks);
        }
        return;
      }

      if (docIsEmpty) {
        if (stateRow?.data && stateRow.data.length > 2) {
          Y.applyUpdate(docRef.current, stateRow.data);
        } else if (!migratedRef.current && initialContent) {
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

  // ── Semantic embedding index (⌘K search) — debounced via interval + hash ──
  useEffect(() => {
    if (!isActive) return;

    function fnv1a(s: string): string {
      let h = 2166136261 >>> 0;
      const len = Math.min(s.length, 20000);
      for (let i = 0; i < len; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return String(h);
    }

    async function tick() {
      try {
        const md = editor.blocksToMarkdownLossy(editor.document);
        const audioExtra = collectAudioTranscripts(editor.document as unknown[]);
        const title = allPages.find((p) => p.id === pageId)?.title ?? "";
        const combined = `${title}\n\n${md}${audioExtra ? `\n\n${audioExtra}` : ""}`.trim();
        if (!combined) return;
        const h = fnv1a(combined);
        if (h === lastEmbedHashRef.current) return;
        const res = await fetch("/api/embed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: combined }),
        });
        if (!res.ok) {
          console.warn("[PearEditor] /api/embed failed", res.status);
          return;
        }
        const data = (await res.json()) as { embedding?: number[] };
        const emb = data.embedding;
        if (!emb?.length) return;
        await setPageEmbedding({ pageId, embedding: emb.map((x) => Number(x)) });
        lastEmbedHashRef.current = h;
      } catch (e) {
        console.warn("[PearEditor] semantic index failed", e);
      }
    }

    /** BlockNote can call flushSync internally — never run during the effect body. */
    function scheduleTick() {
      setTimeout(() => {
        void tick();
      }, 0);
    }

    const id = setInterval(scheduleTick, 45_000);
    scheduleTick();
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, pageId, editor, allPages, setPageEmbedding]);

  // ── Auto-insert child pages as moveable pageLink blocks ──────────────────
  useEffect(() => {
    const pages = childPagesRef.current;
    if (!isActive || !pages?.length) return;

    // Defer to next frame so the editor/Yjs has finished loading content
    // and we can accurately check which pageLink blocks already exist.
    const handle = requestAnimationFrame(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inEditor = new Set(
        (editor.document as any[])
          .filter((b) => b.type === "pageLink")
          .map((b) => b.props?.pageId as string)
      );

      const toInsert = pages.filter((p) => {
        const id = String(p.id);
        return !inEditor.has(id) && !autoInsertedRef.current.has(id);
      });

      if (!toInsert.length) return;

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

      // Mark as inserted AFTER the blocks are actually in the editor
      toInsert.forEach((p) => autoInsertedRef.current.add(String(p.id)));
    });
    return () => cancelAnimationFrame(handle);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, childIdsKey]);

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
      requestAnimationFrame(() => editor.removeBlocks(blocksToRemove));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, childPages]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    const provider = providerRef.current;
    const doc = docRef.current;
    return () => {
      provider.destroy();
      idbRef.current?.destroy();
      doc.destroy();
    };
  }, []);

  const bnTheme = !mounted || resolvedTheme === "dark" ? "dark" : "light";

  const [uploading, setUploading] = useState(false);
  const editorWrapRef = useRef<HTMLDivElement>(null);

  // Tab / Shift+Tab: nest/unnest list items (indent/outdent)
  // Explicit handler ensures this works even if BlockNote's built-in
  // keybinding doesn't fire (e.g. due to browser focus management).
  const NESTABLE_TYPES = new Set(["bulletListItem", "numberedListItem", "checkListItem"]);
  useEffect(() => {
    function handleTab(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      if (!editorWrapRef.current?.contains(document.activeElement)) return;
      try {
        const block = editor.getTextCursorPosition().block;
        if (!NESTABLE_TYPES.has(block.type)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
          if (editor.canUnnestBlock()) editor.unnestBlock();
        } else {
          if (editor.canNestBlock()) editor.nestBlock();
        }
      } catch {
        // noop — cursor might not be in a block
      }
    }
    window.addEventListener("keydown", handleTab, true);
    return () => window.removeEventListener("keydown", handleTab, true);
  }, [editor]);

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
        const contentType = file.type || "image/png";
        const up = await uploadWorkspaceBlob({
          slug: workspaceSlug,
          body: file,
          contentType,
        });
        if (!up) continue;
        const storageKey = up.objectId;
        createAttachment({
          pageId,
          filename: file.name || "image",
          contentType,
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

  async function handleAudioFiles(files: FileList | null) {
    if (!files?.length) return;
    const list = Array.from(files).filter(
      (f) =>
        f.type.startsWith("audio/") || /\.(webm|ogg|mp3|wav|m4a|aac)$/i.test(f.name)
    );
    if (!list.length) return;

    setUploading(true);
    try {
      const cursorBlock = editor.getTextCursorPosition().block;
      const blocksToInsert: Array<{
        type: "audio";
        props: { storageKey: string; transcript: string; durationSec: number; boot: string };
      }> = [];

      for (const file of list) {
        const contentType = file.type || "application/octet-stream";
        const up = await uploadWorkspaceBlob({
          slug: workspaceSlug,
          body: file,
          contentType,
        });
        if (!up) continue;
        const storageKey = up.objectId;
        createAttachment({
          pageId,
          filename: file.name || "audio",
          contentType,
          storageKey,
          sizeBytes: BigInt(file.size),
        });
        blocksToInsert.push({
          type: "audio",
          props: { storageKey, transcript: "", durationSec: 0, boot: "" },
        });
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
    const audios = files ? Array.from(files).filter((f) => f.type.startsWith("audio/")) : [];
    if (images.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      handleImageFiles(files!);
    } else if (audios.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      void handleAudioFiles(files!);
    }
  }

  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleAiSubmit() {
    if (!aiPrompt.trim() || aiSubmitting) return;
    setAiSubmitting(true);
    try {
      const pageText = extractTextFromBlocks(editor.document as unknown[]);
      const fullDescription = pageText
        ? `${aiPrompt.trim()}\n\n---\nPage content:\n${pageText}`
        : aiPrompt.trim();
      await createJob({
        userId: identity?.toHexString() ?? "",
        prompt: aiPrompt.trim(),
        pageId,
        // Always start with an orchestrate task — the worker decomposes the
        // prompt into a proper task graph and writes the subtasks back via
        // add_tasks_to_job before marking itself done.
        taskGraphJson: JSON.stringify([
          {
            description: fullDescription,
            task_type: "orchestrate",
            depends_on: [],
            required_capabilities: ["orchestrate"],
          },
        ]),
      });
      setAiPromptOpen(false);
      setAiPrompt("");
    } catch (err) {
      console.error("[PearEditor] Failed to create AI job", err);
    } finally {
      setAiSubmitting(false);
    }
  }

  const aiSlashItem = {
    title: "Ask AI",
    subtext: "Create an AI job with this page as context",
    aliases: ["ai", "orcha", "ask", "generate", "help", "summarize"],
    group: "AI",
    onItemClick: () => {
      setAiPrompt("");
      setAiPromptOpen(true);
    },
  };

  async function handleMentionAiUser(aiUserId: bigint) {
    const activeConv = conversations.find(
      (c) => c.aiUserId === aiUserId && c.status.tag === "Active"
    );
    if (activeConv) {
      onMentionAiUser?.();
      return;
    }

    try {
      await createConversation({ pageId, aiUserId });
      onMentionAiUser?.();
    } catch (err) {
      console.error("[PearEditor] Failed to create conversation", err);
    }
  }

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

  const newPageSlashItemRef = useRef(newPageSlashItem);
  newPageSlashItemRef.current = newPageSlashItem;
  const aiSlashItemRef = useRef(aiSlashItem);
  aiSlashItemRef.current = aiSlashItem;

  /**
   * Stable function identity: BlockNote's loader re-runs its effect whenever
   * `getItems` changes; an inline async closed over the render cycle caused
   * duplicate rows and flaky filtering. Refs keep handler payloads fresh.
   */
  const getSlashMenuItems = useCallback(async (query: string) => {
    const defaults = getDefaultReactSlashMenuItems(editor);
    const withoutBuiltInImage = defaults.filter((item) => {
      const k = (item as { key?: string }).key;
      return k !== "image" && item.title !== "Image";
    });

    const uploadImageItem = {
      key: "pear-upload-image",
      title: "Upload image",
      subtext: "Upload an image from disk",
      aliases: ["img", "photo", "picture", "image"],
      group: "Image",
      onItemClick: () => fileInputRef.current?.click(),
    };

    const audioBlockItem = {
      key: "pear-audio-block",
      title: "Audio recording",
      subtext: "Record, upload file, or live transcript",
      aliases: [
        "audio",
        "record",
        "recording",
        "transcribe",
        "transcription",
        "dictation",
        "meeting",
        "voice",
        "mic",
        "sound",
        "wav",
        "mp3",
      ],
      group: "Audio",
      onItemClick: () => {
        editor.insertBlocks(
          [
            {
              type: "audio" as const,
              props: { storageKey: "", transcript: "", durationSec: 0, boot: "" },
            },
          ],
          editor.getTextCursorPosition().block,
          "after"
        );
      },
    };

    const all = dedupePearSlashItems([
      ...withoutBuiltInImage,
      uploadImageItem,
      audioBlockItem,
      newPageSlashItemRef.current,
      aiSlashItemRef.current,
    ]);

    if (!query) return all;
    const q = query.toLowerCase();
    return all.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.aliases?.some((a) => a.toLowerCase().includes(q))
    );
  }, [editor]);

  return (
    <AudioAttachmentContext.Provider value={{ pageId, createAttachment }}>
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

      {/* AI prompt overlay — triggered by /AI slash command */}
      {aiPromptOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 dark:bg-black/40 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setAiPromptOpen(false);
          }}
        >
          <div className="w-full max-w-md mx-4 bg-white dark:bg-neutral-900 rounded-xl shadow-2xl border border-neutral-200 dark:border-neutral-700 overflow-hidden">
            <div className="flex items-center gap-2 px-4 pt-4 pb-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-neutral-500 shrink-0"
              >
                <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
              </svg>
              <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
                Ask AI
              </span>
              <span className="text-xs text-neutral-400 dark:text-neutral-500 ml-auto">
                page content included as context
              </span>
            </div>
            <div className="px-4 pb-3">
              <textarea
                autoFocus
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                placeholder="What do you want AI to do?"
                rows={4}
                className="w-full text-sm bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2.5 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 resize-none outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow"
                onKeyDown={(e) => {
                  if (e.key === "Escape") setAiPromptOpen(false);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleAiSubmit();
                  }
                }}
              />
            </div>
            <div className="flex items-center justify-end gap-2 px-4 pb-4">
              <button
                onClick={() => setAiPromptOpen(false)}
                className="px-3 py-1.5 rounded-lg text-sm text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleAiSubmit()}
                disabled={!aiPrompt.trim() || aiSubmitting}
                className="px-4 py-1.5 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-40 transition-colors"
              >
                {aiSubmitting ? "Creating…" : "Create job  ⌘↵"}
              </button>
            </div>
          </div>
        </div>
      )}

      <BlockNoteView editor={editor} theme={bnTheme} slashMenu={false}>
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={getSlashMenuItems}
        />
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={async (query: string) => {
            const q = query.toLowerCase();

            const humanItems = workspaceUsers
              .filter((u) => {
                if (identity && u.identity.isEqual(identity)) return false;
                const name = u.name || u.email || "";
                return !q || name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
              })
              .map((u) => ({
                title: u.name || u.email || u.identity.toHexString().slice(0, 8),
                subtext: u.email || "Member",
                onItemClick: () => {},
              }));

            const aiItems = aiUsers
              .filter(
                (u) =>
                  !q ||
                  u.displayName.toLowerCase().includes(q) ||
                  u.modelName.toLowerCase().includes(q) ||
                  u.providerName.toLowerCase().includes(q)
              )
              .map((u) => ({
                title: u.displayName,
                subtext: `${u.providerName} · ${u.modelName}`,
                onItemClick: () => {
                  handleMentionAiUser(u.aiUserId);
                },
              }));

            return [...humanItems, ...aiItems];
          }}
        />
      </BlockNoteView>

      <MeetingNotesBanner
        showPermissionPrompt={showPermissionPrompt}
        showMeetingPrompt={showMeetingPrompt}
        fromDesktopTray={desktopTrayHint}
        onRequestPermission={requestPermission}
        onStartRecording={() => {
          const cursor = editor.getTextCursorPosition().block;
          editor.insertBlocks(
            [
              {
                type: "audio" as const,
                props: {
                  storageKey: "",
                  transcript: "",
                  durationSec: 0,
                  boot: "record",
                },
              },
            ],
            cursor,
            "after"
          );
        }}
        onDismiss={() => {
          setMeetingBannerDismissed(true);
          setMeetingBannerDismissedSession();
          clearDesktopTrayHint();
        }}
      />
    </div>
    </AudioAttachmentContext.Provider>
  );
}

/** Walk block tree for audio transcripts (Markdown export omits custom blocks). */
function collectAudioTranscripts(blocks: unknown[]): string {
  const parts: string[] = [];
  function walk(list: unknown[]) {
    for (const node of list) {
      if (!node || typeof node !== "object") continue;
      const b = node as Record<string, unknown>;
      if (b.type === "audio") {
        const pr = b.props as Record<string, unknown> | undefined;
        const tr = typeof pr?.transcript === "string" ? pr.transcript.trim() : "";
        if (tr) parts.push(tr);
      }
      if (Array.isArray(b.children)) walk(b.children as unknown[]);
    }
  }
  walk(blocks);
  return parts.join("\n\n");
}

function safeParseBlocks(content: string) {
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Recursively extract plain text from a BlockNote document for AI context. */
function extractTextFromBlocks(blocks: unknown[]): string {
  return blocks
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as Record<string, unknown>;
      if (b.type === "audio") {
        const pr = b.props as Record<string, unknown> | undefined;
        const tr = typeof pr?.transcript === "string" ? pr.transcript : "";
        const childText = Array.isArray(b.children)
          ? extractTextFromBlocks(b.children as unknown[])
          : "";
        return [tr, childText].filter(Boolean).join("\n");
      }
      const inlineText = Array.isArray(b.content)
        ? (b.content as Array<Record<string, unknown>>)
            .map((n) => (typeof n.text === "string" ? n.text : ""))
            .join("")
        : "";
      const childText = Array.isArray(b.children)
        ? extractTextFromBlocks(b.children as unknown[])
        : "";
      return [inlineText, childText].filter(Boolean).join("\n");
    })
    .filter(Boolean)
    .join("\n");
}
