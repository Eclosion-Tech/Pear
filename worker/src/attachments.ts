/**
 * Resolves `ConversationAttachment` rows into provider-ready message content:
 *   - Image  → S3 fetch → base64 `ImageBlock` (provider adapters translate;
 *              Anthropic passes through, OpenAI-family → data-URL `image_url`).
 *   - Page   → snapshot markdown captured at drag time (`content_snapshot`).
 *   - Blocks → snapshot markdown of the selected blocks (`content_snapshot`).
 *
 * Page/Blocks resolution is sync (the snapshot lives in the row); images are
 * async (S3 GetObject). `resolveConversationAttachments` does the async work
 * once per turn so `reconstructSessionTail` can stay synchronous.
 */

import type { ConnLike } from "./tools.js";
import type { ImageBlock } from "./providers.js";
import { fetchObjectBase64, isS3Configured } from "./s3.js";

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
 * Resolve every attachment in a conversation, keyed by message id.
 * Image fetch failures degrade to a context note (the turn must not die
 * because one S3 object vanished); page/block snapshots never fail.
 */
export async function resolveConversationAttachments(
  conn: ConnLike,
  conversationId: bigint,
  logTag: string,
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

    if (kind === "Page" || kind === "Blocks") {
      const snapshot = optString(row.contentSnapshot);
      const name = optString(row.fileName);
      const label =
        kind === "Page"
          ? `Attached page${name ? ` "${name}"` : ""}${row.pageId != null ? ` (page ${row.pageId})` : ""}, snapshot at attach time`
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
