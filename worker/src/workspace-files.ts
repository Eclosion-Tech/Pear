/**
 * Worker implementation of the MCP core's `WorkspaceFileReader`: fetch a
 * workspace blob from S3 and reduce it to text where we can.
 *
 * Consumers:
 *   - `read_file` (chat parity + the worker's stdio/http MCP hosts)
 *   - `File` chat attachments (`attachments.ts`) — the same extraction feeds
 *     the turn so a dropped PDF/CSV is readable without a tool call.
 *
 * Key resolution. Page blocks and File property cells store a BARE objectId
 * (portable across slugs — the renderer builds the URL with the current
 * workspace); chat attachments store the FULL `workspaces/{wsId}/{objectId}`
 * key. Bare ids are resolved inside THIS workspace's prefix only, so an AI
 * user cannot reach another workspace's blob by guessing its id. The
 * workspace id comes from the lifecycle `blob-context` endpoint the Notion
 * importer already uses (cached per module); standalone deployments without
 * a lifecycle fall back to the bare key.
 *
 * Extraction is opt-in by type (see `extractorFor` in the core):
 *   utf8 → TextDecoder after a binary sniff; pdf → unpdf; docx → mammoth.
 * Everything else returns metadata only. Both extractor libraries are
 * imported lazily so a worker that never sees a PDF never loads pdf.js.
 */

import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  capText,
  decodeUtf8,
  extractorFor,
  looksLikeUtf8Text,
  type WorkspaceFile,
  type WorkspaceFileReader,
} from "../../web/src/lib/mcp/index.js";
import { getS3Client, isS3Configured, s3Bucket } from "./s3.js";

/** Largest object we will pull into memory for extraction. */
export const MAX_READ_BYTES = 25 * 1024 * 1024;
/** Largest text we keep from one file (pre-windowing; `read_file` pages it). */
export const MAX_TEXT_CHARS = 2_000_000;

export interface WorkspaceFilesOptions {
  /** SpacetimeDB module name (== workspace slug in cloud). */
  dbName: string;
  /** Override for tests; defaults to the lifecycle-backed resolver. */
  resolveWorkspaceId?: (dbName: string) => Promise<string | null>;
  /** Override for tests; defaults to S3 GetObject. */
  fetchObject?: (key: string) => Promise<FetchedObject | null>;
}

export interface FetchedObject {
  bytes: Uint8Array;
  contentType?: string;
  byteSize: number;
}

// ── Workspace id via lifecycle ─────────────────────────────────────────────────

const workspaceIdCache = new Map<string, { id: string | null; expiresAt: number }>();
const WORKSPACE_ID_TTL_MS = 10 * 60_000;

async function lifecycleWorkspaceId(dbName: string): Promise<string | null> {
  const hit = workspaceIdCache.get(dbName);
  if (hit && hit.expiresAt > Date.now()) return hit.id;

  const base = process.env.LIFECYCLE_URL?.trim().replace(/\/$/, "");
  const token = process.env.SPACETIMEDB_ADMIN_TOKEN?.trim();
  let id: string | null = null;
  if (base && token) {
    try {
      const res = await fetch(
        `${base}/api/internal/workspaces/${encodeURIComponent(dbName)}/blob-context`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.ok) {
        const body = (await res.json()) as { workspace_id?: string };
        id = typeof body.workspace_id === "string" && body.workspace_id ? body.workspace_id : null;
      } else {
        console.warn(`[workspace-files] lifecycle blob-context ${res.status} for ${dbName}`);
      }
    } catch (err) {
      console.warn(`[workspace-files] lifecycle blob-context failed for ${dbName}:`, err);
    }
  }
  // Negative results are cached briefly too — a misconfigured lifecycle must
  // not turn every read_file call into a network round-trip.
  workspaceIdCache.set(dbName, {
    id,
    expiresAt: Date.now() + (id ? WORKSPACE_ID_TTL_MS : 30_000),
  });
  return id;
}

// ── S3 fetch ──────────────────────────────────────────────────────────────────

async function s3FetchObject(key: string): Promise<FetchedObject | null> {
  const client = getS3Client();
  const bucket = s3Bucket();
  let head;
  try {
    head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const byteSize = Number(head.ContentLength ?? 0);
  const contentType = head.ContentType || undefined;
  if (byteSize > MAX_READ_BYTES) {
    // Report metadata without pulling the bytes; the caller explains the cap.
    return { bytes: new Uint8Array(0), contentType, byteSize };
  }
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) return { bytes: new Uint8Array(0), contentType, byteSize };
  const bytes = await res.Body.transformToByteArray();
  return { bytes, contentType: res.ContentType || contentType, byteSize: bytes.byteLength || byteSize };
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NotFound" ||
    e?.name === "NoSuchKey" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

// ── Extraction ────────────────────────────────────────────────────────────────

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return typeof text === "string" ? text : String(text ?? "");
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return result.value;
}

/**
 * Reduce fetched bytes to `WorkspaceFile` text fields. Exported so the
 * attachment resolver and tests can run extraction without S3.
 */
export async function extractWorkspaceFileText(
  obj: FetchedObject,
  storageKey: string,
  filename?: string,
): Promise<WorkspaceFile> {
  const base: WorkspaceFile = {
    storageKey,
    contentType: obj.contentType,
    byteSize: obj.byteSize,
  };
  if (obj.byteSize > MAX_READ_BYTES) {
    return {
      ...base,
      note: `File is ${obj.byteSize} bytes; extraction is capped at ${MAX_READ_BYTES} bytes. Ask for a smaller export.`,
    };
  }
  const extractor = extractorFor(obj.contentType, filename);
  try {
    if (extractor === "utf8") {
      if (!looksLikeUtf8Text(obj.bytes)) {
        return { ...base, note: "Declared as text but the bytes are not UTF-8 text; no extraction." };
      }
      const { text, truncated } = capText(decodeUtf8(obj.bytes), MAX_TEXT_CHARS);
      return { ...base, text, extractor: "utf8", textTruncated: truncated || undefined };
    }
    if (extractor === "pdf") {
      const { text, truncated } = capText(normaliseWhitespace(await extractPdf(obj.bytes)), MAX_TEXT_CHARS);
      return {
        ...base,
        text,
        extractor: "pdf",
        textTruncated: truncated || undefined,
        note: text.trim() ? undefined : "PDF contains no extractable text (scanned image?).",
      };
    }
    if (extractor === "docx") {
      const { text, truncated } = capText(await extractDocx(obj.bytes), MAX_TEXT_CHARS);
      return { ...base, text, extractor: "docx", textTruncated: truncated || undefined };
    }
    // Untyped upload (no MIME or the generic one): a last-chance sniff catches
    // text files with an unfamiliar extension. Declared binary types (image/,
    // audio/, zip, …) are never sniffed.
    const mime = (obj.contentType ?? "").split(";")[0].trim().toLowerCase();
    const untyped = mime === "" || mime === "application/octet-stream";
    if (untyped && obj.bytes.length > 0 && looksLikeUtf8Text(obj.bytes)) {
      const { text, truncated } = capText(decodeUtf8(obj.bytes), MAX_TEXT_CHARS);
      return { ...base, text, extractor: "utf8", textTruncated: truncated || undefined };
    }
    return base;
  } catch (err) {
    return {
      ...base,
      note: `Extraction (${extractor}) failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function normaliseWhitespace(s: string): string {
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Reader ────────────────────────────────────────────────────────────────────

/**
 * Build a reader bound to one workspace (module). `null` when the worker has
 * no S3 configuration — callers then omit `ctx.files` and `read_file` says so.
 */
export function createWorkspaceFileReader(opts: WorkspaceFilesOptions): WorkspaceFileReader | null {
  const fetchObject = opts.fetchObject ?? (isS3Configured() ? s3FetchObject : null);
  if (!fetchObject) return null;
  const resolveWorkspaceId = opts.resolveWorkspaceId ?? lifecycleWorkspaceId;

  return {
    async read(storageKey: string): Promise<WorkspaceFile | null> {
      const key = storageKey.trim();
      if (!key) return null;
      const s3Key = await resolveS3Key(key);
      if (!s3Key) return null;
      const obj = await fetchObject(s3Key);
      if (!obj) return null;
      return extractWorkspaceFileText(obj, key);
    },
  };

  /**
   * Map a caller-supplied key onto this workspace's S3 prefix.
   *   - bare objectId → `workspaces/{wsId}/{objectId}`
   *   - full key      → accepted only if it already sits under this
   *                     workspace's prefix; anything else is "not found", so a
   *                     chat attachment key from another workspace (or a
   *                     hand-built one) can never cross the tenancy boundary.
   * Without a known workspace id (standalone deployments) keys pass through.
   */
  async function resolveS3Key(key: string): Promise<string | null> {
    const wsId = await resolveWorkspaceId(opts.dbName);
    if (!wsId) return key;
    const prefix = `workspaces/${wsId}/`;
    if (!key.includes("/")) return `${prefix}${key}`;
    return key.startsWith(prefix) ? key : null;
  }
}

const readers = new Map<string, WorkspaceFileReader | null>();

/** Per-module reader cache — one S3 client and one workspace-id lookup each. */
export function workspaceFileReaderFor(dbName: string): WorkspaceFileReader | undefined {
  if (!readers.has(dbName)) readers.set(dbName, createWorkspaceFileReader({ dbName }));
  return readers.get(dbName) ?? undefined;
}

/** Test hook: drop cached readers/workspace ids. */
export function _resetWorkspaceFileCaches(): void {
  readers.clear();
  workspaceIdCache.clear();
}
