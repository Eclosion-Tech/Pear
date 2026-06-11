"use client";

/**
 * Chat composer attachments — shared types + helpers for the AI panel.
 *
 * Three kinds (mirrors the module's `AttachmentKind`):
 *   - image:  uploaded via the workspace blob API (same pipeline as editor
 *             images); `object_key` stores the full S3 key so the AI worker
 *             can fetch the bytes and hand them to the provider as a vision
 *             block.
 *   - page:   a page dragged from the sidebar; we snapshot its text at drag
 *             time (from the latest `page_snapshot` row) into contentSnapshot.
 *   - blocks: a text/block selection dragged from the editor; the dragged
 *             text is the snapshot.
 */

import type { AttachmentSpec } from "@/src/module_bindings/types";
import { uploadWorkspaceBlob, workspaceBlobSrc } from "@/src/lib/blobUpload";

/** DataTransfer MIME type set by sidebar page rows on drag. */
export const PAGE_DRAG_MIME = "application/x-pear-page";

export type PageDragPayload = { pageId: string; title: string };

export type PendingAttachment =
  | {
      id: string;
      kind: "image";
      fileName: string;
      mimeType: string;
      /** Local object URL for the composer thumbnail. */
      previewUrl: string;
      /** S3 key once uploaded; absent while uploading or on error. */
      objectKey?: string;
      status: "uploading" | "ready" | "error";
    }
  | { id: string; kind: "page"; pageId: bigint; title: string; snapshot: string }
  | { id: string; kind: "blocks"; pageId?: bigint; title?: string; snapshot: string };

let nextLocalId = 0;
export function newLocalId(): string {
  return `att-${Date.now()}-${nextLocalId++}`;
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/**
 * Upload a chat image through the workspace blob API (same pipeline as editor
 * images). Returns the full S3 key (`workspaces/{workspaceId}/{objectId}`),
 * or null on failure (logged by the helper).
 */
export async function uploadChatImage(
  slug: string,
  file: File,
): Promise<string | null> {
  const up = await uploadWorkspaceBlob({
    slug,
    body: file,
    contentType: file.type || "application/octet-stream",
  });
  if (!up) return null;
  if (!up.storageKey) {
    // API predates storageKey in the presign response — the worker can't
    // resolve a bare objectId to an S3 key, so treat as failed.
    console.error("[chatAttachments] upload-url API did not return storageKey");
    return null;
  }
  return up.storageKey;
}

/**
 * Browser-displayable URL for a sent image attachment. `objectKey` is the
 * full S3 key; the blob raw route addresses by objectId (last segment).
 */
export function chatImageSrc(slug: string, objectKey: string): string {
  const objectId = objectKey.split("/").pop() ?? "";
  return workspaceBlobSrc(slug, objectId);
}

/** Convert ready pending attachments into reducer `AttachmentSpec`s. */
export function toAttachmentSpecs(pending: PendingAttachment[]): AttachmentSpec[] {
  const specs: AttachmentSpec[] = [];
  for (const att of pending) {
    if (att.kind === "image") {
      if (att.status !== "ready" || !att.objectKey) continue;
      specs.push({
        kind: { tag: "Image" },
        objectKey: att.objectKey,
        mimeType: att.mimeType,
        fileName: att.fileName,
        pageId: undefined,
        contentSnapshot: undefined,
      });
    } else if (att.kind === "page") {
      specs.push({
        kind: { tag: "Page" },
        objectKey: undefined,
        mimeType: undefined,
        fileName: att.title,
        pageId: att.pageId,
        contentSnapshot: att.snapshot,
      });
    } else {
      specs.push({
        kind: { tag: "Blocks" },
        objectKey: undefined,
        mimeType: undefined,
        fileName: att.title,
        pageId: att.pageId,
        contentSnapshot: att.snapshot,
      });
    }
  }
  return specs;
}

/** Extract plain text from a `page_snapshot.content` BlockNote block-JSON string. */
export function extractTextFromBlockJson(json: string): string {
  try {
    const blocks: unknown[] = JSON.parse(json);
    return extractTextFromBlocks(blocks);
  } catch {
    return "";
  }
}

function extractTextFromBlocks(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (Array.isArray(b.content)) {
      const line: string[] = [];
      for (const inline of b.content as Array<Record<string, unknown>>) {
        if (typeof inline.text === "string") line.push(inline.text);
      }
      if (line.length) parts.push(line.join(""));
    }
    if (Array.isArray(b.children)) {
      const child = extractTextFromBlocks(b.children as unknown[]);
      if (child) parts.push(child);
    }
  }
  return parts.filter(Boolean).join("\n");
}
