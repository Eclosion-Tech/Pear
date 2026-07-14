/**
 * Worker-side Notion attachment re-upload.
 *
 * Bytes go straight to S3 with the worker's own credentials; blob METADATA
 * (the `workspace_blobs` row that makes an object servable via
 * `/api/workspaces/[slug]/blobs/[objectId]/raw`, plus quota accounting) lives
 * in the control-plane Postgres, which the worker cannot reach — so each
 * upload is registered through lifecycle's internal API (same admin-token
 * auth the worker already uses for AI-user discovery).
 */
import { randomUUID } from "node:crypto";

import { putObjectBytes } from "../s3.js";
import { ssrfSafeFetch } from "../ssrf.js";
import type { AttachmentRef } from "./fetcher.js";

/** Mirrors web/lib/notion-attachment-upload.ts — the transformer consumes this shape. */
export type AttachmentUploadResult = {
  notionUrl: string;
  objectId: string;
  byteSize: number;
  contentType: string;
};

const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Full URL path for logs (the Notion S3 path ends in the real filename);
 * the presigned signature query is noise and mildly sensitive — drop it. */
function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

type BlobContext = { workspace_id: string; quota_bytes: number; used_bytes: number };

function lifecycleBase(): string {
  const url = process.env.LIFECYCLE_URL?.trim();
  if (!url) throw new Error("LIFECYCLE_URL is not set");
  return url.replace(/\/$/, "");
}

function adminToken(): string {
  const t = process.env.SPACETIMEDB_ADMIN_TOKEN?.trim();
  if (!t) throw new Error("SPACETIMEDB_ADMIN_TOKEN is not set");
  return t;
}

async function lifecycleFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${lifecycleBase()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${adminToken()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function getBlobContext(moduleName: string): Promise<BlobContext> {
  const res = await lifecycleFetch(
    `/api/internal/workspaces/${encodeURIComponent(moduleName)}/blob-context`,
  );
  if (!res.ok) {
    throw new Error(`lifecycle blob-context failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as BlobContext;
}

async function registerBlob(
  moduleName: string,
  objectId: string,
  byteSize: number,
  contentType: string,
  createdBy: string,
): Promise<"ok" | "quota"> {
  const res = await lifecycleFetch(
    `/api/internal/workspaces/${encodeURIComponent(moduleName)}/blobs`,
    {
      method: "POST",
      body: JSON.stringify({
        object_id: objectId,
        byte_size: byteSize,
        content_type: contentType,
        created_by: createdBy,
      }),
    },
  );
  if (res.status === 413) return "quota";
  if (!res.ok) {
    throw new Error(`lifecycle blob register failed (${res.status}): ${await res.text()}`);
  }
  return "ok";
}

/**
 * Download each Notion-hosted file and re-home it as a workspace blob.
 * Mirrors the web uploader's behavior: per-file size cap, quota-aware
 * (stops uploading once the workspace quota would be exceeded — the import
 * continues without the remaining attachments), and per-file errors are
 * skipped rather than fatal.
 */
export async function uploadNotionAttachments(
  moduleName: string,
  refs: AttachmentRef[],
  createdBy: string,
  log: (msg: string) => void,
): Promise<Map<string, AttachmentUploadResult>> {
  const results = new Map<string, AttachmentUploadResult>();
  if (refs.length === 0) return results;

  const ctx = await getBlobContext(moduleName);
  let budget = Math.max(0, ctx.quota_bytes - ctx.used_bytes);
  let quotaHit = false;

  // De-dup by URL and skip external links (YouTube etc.) — the same file
  // can be referenced from several blocks.
  const seen = new Set<string>();
  const unique = refs.filter((r) => {
    if (r.isExternal || seen.has(r.notionUrl)) return false;
    seen.add(r.notionUrl);
    return true;
  });

  for (let i = 0; i < unique.length; i++) {
    const ref = unique[i];
    if (quotaHit) break;
    if (i % 10 === 0) log(`Uploading attachments ${i + 1}/${unique.length}…`);
    try {
      // Attachment URLs originate in imported (untrusted) Notion data and the
      // worker runs on the host network — never fetch them unguarded.
      const res = await ssrfSafeFetch(ref.notionUrl);
      if (!res.ok) {
        log(`WARN: attachment fetch ${res.status} — skipping ${ref.notionUrl.slice(0, 80)}`);
        continue;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
        log(
          `WARN: attachment "${ref.filename || describeUrl(ref.notionUrl)}" ` +
            `${bytes.length} bytes out of range — skipped`,
        );
        continue;
      }
      if (bytes.length > budget) {
        quotaHit = true;
        log(`WARN: workspace blob quota reached — remaining attachments skipped`);
        break;
      }
      const contentType =
        res.headers.get("content-type")?.split(";")[0]?.trim() ||
        ref.mimeType ||
        "application/octet-stream";
      const objectId = randomUUID();
      await putObjectBytes(`workspaces/${ctx.workspace_id}/${objectId}`, bytes, contentType);
      const reg = await registerBlob(moduleName, objectId, bytes.length, contentType, createdBy);
      if (reg === "quota") {
        quotaHit = true;
        log(`WARN: workspace blob quota reached — remaining attachments skipped`);
        break;
      }
      budget -= bytes.length;
      results.set(ref.notionUrl, {
        notionUrl: ref.notionUrl,
        objectId,
        byteSize: bytes.length,
        contentType,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`WARN: attachment upload failed — skipped: ${msg}`);
    }
  }
  log(`Attachments: ${results.size}/${unique.length} re-uploaded`);
  return results;
}
