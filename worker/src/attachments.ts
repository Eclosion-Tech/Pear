/**
 * Resolves `ConversationAttachment` rows into provider-ready message content:
 *   - Image  → S3 fetch → base64 `ImageBlock` (provider adapters translate;
 *              Anthropic passes through, OpenAI-family → data-URL `image_url`).
 *   - Page   → the page's CURRENT body, read live from the subscribed
 *              component tree (the documented `AttachmentKind::Page`
 *              semantics); falls back to the drag-time `content_snapshot`
 *              for legacy BlockNote pages or when the tree is unavailable.
 *              (The web-side snapshot is BlockNote-shaped text extraction,
 *              which yields "" for ComponentTree pages — so without the live
 *              read a dragged page arrived as title-only context.)
 *   - Blocks → snapshot markdown of the selected blocks (`content_snapshot`).
 *   - File   → S3 fetch → extracted text (txt/csv/json/pdf/docx…) inlined as
 *              `<attached_file>` context, capped; the model can window the
 *              rest with `read_file(storage_key)`. Binary formats without an
 *              extractor become a metadata note instead.
 *
 * Page/Blocks resolution is sync (the snapshot lives in the row); images and
 * files are async (S3 GetObject). `resolveConversationAttachments` does the
 * async work once per turn so `reconstructSessionTail` can stay synchronous.
 */

import type { ConnLike } from "./tools.js";
import type { ImageBlock } from "./providers.js";
import { fetchObjectBase64, isS3Configured } from "./s3.js";
import { readComponentTreeDoc } from "./component-authoring.js";
import type { WorkspaceFileReader } from "../../web/src/lib/mcp/index.js";

// ── Row shapes (from generated bindings; options may be bare or tagged) ───────

type AttachmentRow = {
  id: bigint;
  messageId: bigint;
  conversationId: bigint;
  kind: { tag: string };
  objectKey: string | undefined;
  mimeType: string | undefined;
  fileName: string | undefined;
  pageId: bigint | undefined;
  contentSnapshot: string | undefined;
};

function optString(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.length > 0 ? v : undefined;
  if (typeof v === "object" && "tag" in (v as object)) {
    const o = v as { tag: string; value?: string };
    if (o.tag === "some" && o.value) return o.value;
  }
  return undefined;
}

/** Media types vision models broadly accept; anything else is sent as png and may be rejected upstream. */
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// ── Resolved output ────────────────────────────────────────────────────────────

export type ResolvedMessageAttachments = {
  /** Vision blocks for image attachments, in attachment order. */
  images: ImageBlock[];
  /** Context text (page/block snapshots) to append after the user's message text. */
  contextText: string;
};

/**
 * Inline cap for one attached file's text. Beyond this the model sees the
 * head plus a pointer to `read_file` — a 200-page PDF should not silently
 * swallow the whole context window on every turn of the conversation.
 */
export const ATTACHED_FILE_INLINE_CHARS = 40_000;

/**
 * Resolve every attachment in a conversation, keyed by message id.
 * Image/file fetch failures degrade to a context note (the turn must not die
 * because one S3 object vanished); page/block snapshots never fail.
 *
 * `files` is the workspace's blob reader; when the host has none, File
 * attachments resolve to a note naming the file so the model still knows it
 * was sent.
 */
export async function resolveConversationAttachments(
  conn: ConnLike,
  conversationId: bigint,
  logTag: string,
  files?: WorkspaceFileReader,
): Promise<Map<bigint, ResolvedMessageAttachments>> {
  const rows = [...(conn.db.conversation_attachment.iter() as Iterable<AttachmentRow>)]
    .filter((r) => r.conversationId === conversationId)
    .sort((a, b) => Number(a.id - b.id));

  const result = new Map<bigint, ResolvedMessageAttachments>();
  if (rows.length === 0) return result;

  const entryFor = (messageId: bigint): ResolvedMessageAttachments => {
    let entry = result.get(messageId);
    if (!entry) {
      entry = { images: [], contextText: "" };
      result.set(messageId, entry);
    }
    return entry;
  };

  const appendContext = (entry: ResolvedMessageAttachments, text: string) => {
    entry.contextText += (entry.contextText ? "\n\n" : "") + text;
  };

  for (const row of rows) {
    const entry = entryFor(row.messageId);
    const kind = row.kind?.tag;

    if (kind === "Image") {
      const objectKey = optString(row.objectKey);
      const fileName = optString(row.fileName) ?? "image";
      if (!objectKey) continue;
      if (!isS3Configured()) {
        appendContext(
          entry,
          `[Attached image "${fileName}" could not be loaded: S3 is not configured for this worker]`,
        );
        continue;
      }
      try {
        const data = await fetchObjectBase64(objectKey);
        const rawType = optString(row.mimeType) ?? "image/png";
        const mediaType = SUPPORTED_IMAGE_TYPES.has(rawType) ? rawType : "image/png";
        entry.images.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data },
        });
      } catch (err) {
        console.error(`${logTag} failed to fetch image attachment ${objectKey}:`, err);
        appendContext(entry, `[Attached image "${fileName}" could not be loaded]`);
      }
      continue;
    }

    if (kind === "File") {
      const objectKey = optString(row.objectKey);
      const fileName = optString(row.fileName) ?? "file";
      const mime = optString(row.mimeType);
      if (!objectKey) continue;
      appendContext(
        entry,
        await renderAttachedFile(files, objectKey, fileName, mime, logTag),
      );
      continue;
    }

    if (kind === "Page" || kind === "Blocks") {
      let snapshot = optString(row.contentSnapshot);
      let freshness = "snapshot at attach time";
      if (kind === "Page" && row.pageId != null) {
        const live = livePageBody(conn, row.pageId);
        if (live) {
          snapshot = live;
          freshness = "current content";
        }
      }
      const name = optString(row.fileName);
      const label =
        kind === "Page"
          ? `Attached page${name ? ` "${name}"` : ""}${row.pageId != null ? ` (page ${row.pageId})` : ""}, ${freshness}`
          : `Attached block selection${name ? ` from "${name}"` : ""}${row.pageId != null ? ` (page ${row.pageId})` : ""}`;
      appendContext(
        entry,
        snapshot
          ? `<attached_context>\n${label}:\n\n${snapshot}\n</attached_context>`
          : `[${label} — no content captured]`,
      );
    }
  }

  return result;
}

/**
 * Current body of an attached page from the subscribed rows: the component
 * tree for ComponentTree pages, `page_content` for legacy BlockNote pages.
 * Empty/undefined when neither is available (caller keeps the snapshot).
 */
export function livePageBody(conn: ConnLike, pageId: bigint): string | undefined {
  try {
    const tree = readComponentTreeDoc(conn, pageId);
    if (tree !== undefined) return tree.trim() ? tree : undefined;
    const table = (conn.db as { page_content?: { pageId?: { find(id: bigint): { content?: string } | undefined } } })
      .page_content;
    const legacy = table?.pageId?.find(pageId)?.content;
    return legacy && legacy.trim() ? legacy : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render one File attachment as context text. Exported for tests.
 *
 *   - no reader      → "[Attached file "x" (type) — contents unavailable …]"
 *   - missing object → "[… could not be loaded]"
 *   - text extracted → <attached_file name type size storage_key>…</attached_file>
 *                      (capped; a trailing note tells the model how to read on)
 *   - binary         → metadata-only note with the storage key
 */
export async function renderAttachedFile(
  files: WorkspaceFileReader | undefined,
  objectKey: string,
  fileName: string,
  mime: string | undefined,
  logTag: string,
): Promise<string> {
  const typeNote = mime ? ` (${mime})` : "";
  if (!files) {
    return `[Attached file "${fileName}"${typeNote} — contents unavailable: this worker has no blob storage configured. storage_key=${objectKey}]`;
  }
  let file;
  try {
    file = await files.read(objectKey);
  } catch (err) {
    console.error(`${logTag} failed to read file attachment ${objectKey}:`, err);
    return `[Attached file "${fileName}"${typeNote} could not be loaded. storage_key=${objectKey}]`;
  }
  if (!file) {
    return `[Attached file "${fileName}"${typeNote} could not be loaded (object missing). storage_key=${objectKey}]`;
  }
  const header =
    `<attached_file name="${escapeAttr(fileName)}"` +
    (file.contentType ? ` type="${escapeAttr(file.contentType)}"` : "") +
    ` size_bytes="${file.byteSize}" storage_key="${escapeAttr(objectKey)}">`;
  if (file.text === undefined) {
    const note = file.note ? ` ${file.note}` : "";
    return `[Attached file "${fileName}"${typeNote}, ${file.byteSize} bytes — no text extractor for this format; only metadata is available.${note} storage_key=${objectKey}]`;
  }
  const total = file.text.length;
  const shown = file.text.slice(0, ATTACHED_FILE_INLINE_CHARS);
  const tail =
    total > shown.length
      ? `\n\n[… ${total - shown.length} more characters. Call read_file(storage_key="${objectKey}", offset=${shown.length}) to continue.]`
      : file.textTruncated
        ? "\n\n[… extraction stopped at the size cap.]"
        : "";
  const note = file.note ? `\n[${file.note}]` : "";
  return `${header}\n${shown}${tail}${note}\n</attached_file>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
