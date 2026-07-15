/**
 * Notion API fetcher — rate-limited, recursive, fully typed for @notionhq/client v5.
 *
 * v5 naming changes from v2:
 *  - "databases" are now "data sources" (object type: "data_source")
 *  - Search filter uses `value: "data_source"` (not "database")
 *  - `notion.databases.query()` → `notion.dataSources.query({ data_source_id })`
 *  - `isFullDatabase` → `isFullDataSource` (type guard)
 *
 * Notion allows 3 requests/second per integration token.
 * We use sequential calls with ≥333ms gap to stay within limits.
 *
 * All accessible Notion workspace content is fetched:
 *   - Pages (object: "page")
 *   - Data sources / databases (object: "data_source")
 *   - Blocks for each page (recursive)
 *   - Data source row pages (query)
 *   - Comments for each page
 *
 * File/attachment URLs are collected for later S3 re-upload.
 */

import {
  Client,
  LogLevel,
  isFullPage,
  isFullDataSource,
  isFullBlock,
} from "@notionhq/client";
import type {
  PageObjectResponse,
  DataSourceObjectResponse,
  BlockObjectResponse,
  CommentObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A page or data source (database) from Notion. */
export type NotionPage = PageObjectResponse | DataSourceObjectResponse;

export type AttachmentRef = {
  /** Original Notion presigned URL (expires ~1 h). */
  notionUrl: string;
  /** The Notion page/database ID this attachment belongs to. */
  pageId: string;
  /** Original filename (may be empty string for inline images). */
  filename: string;
  /** MIME type hint from Notion (may be empty string). */
  mimeType: string;
  /** Whether this is an external URL (YouTube, etc.) — skip re-upload. */
  isExternal: boolean;
};

export type NotionFetchResult = {
  /** All top-level and nested pages + data sources, keyed by Notion UUID. */
  pages: Map<string, NotionPage>;
  /** pageId → flat ordered list of blocks (children recursively inlined). */
  blocks: Map<string, BlockObjectResponse[]>;
  /** pageId → list of top-level comments. */
  comments: Map<string, CommentObjectResponse[]>;
  /** All file/image attachment references found in blocks and properties. */
  attachmentRefs: AttachmentRef[];
  /**
   * Notion user id → display name, from the workspace user directory. Used
   * to render people/created_by values and comment authors as names instead
   * of raw UUIDs. Empty when the integration lacks user-read capability.
   */
  userNames: Map<string, string>;
};

// ── Rate limiter ──────────────────────────────────────────────────────────────

const MIN_INTERVAL_MS = 334; // ≥333 ms → ≤3 req/s

function makeRateLimiter() {
  let lastCallAt = 0;
  return async function rateLimit() {
    const now = Date.now();
    const elapsed = now - lastCallAt;
    if (elapsed < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - elapsed);
    }
    lastCallAt = Date.now();
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractPlainText(richText: RichTextItemResponse[]): string {
  return richText.map((r) => r.plain_text).join("");
}

type NotionFile =
  | { type: "external"; external: { url: string } }
  | { type: "file"; file: { url: string; expiry_time: string } };

function extractFileRef(
  file: NotionFile,
  pageId: string,
  filename: string,
  mimeType: string
): AttachmentRef | null {
  if (file.type === "external") {
    return { notionUrl: file.external.url, pageId, filename, mimeType, isExternal: true };
  }
  if (file.type === "file") {
    return { notionUrl: file.file.url, pageId, filename, mimeType, isExternal: false };
  }
  return null;
}

// ── Main fetch function ───────────────────────────────────────────────────────

/**
 * Fetch all accessible content from the Notion workspace associated with
 * the given access token. Returns a structured result ready for transformation.
 */
export async function fetchNotionWorkspace(
  accessToken: string,
  onProgress?: (msg: string) => void,
  // Test seam: a stub standing in for the Notion client. Production always
  // constructs the real one from the token.
  clientOverride?: Client
): Promise<NotionFetchResult> {
    // Errors only: tolerated per-object 404s (restricted comments etc.) are
  // logged by the SDK at warn and would otherwise dominate the log.
  const notion = clientOverride ?? new Client({ auth: accessToken, logLevel: LogLevel.ERROR });
  const rateLimit = makeRateLimiter();

  const pages = new Map<string, NotionPage>();
  const blocks = new Map<string, BlockObjectResponse[]>();
  const comments = new Map<string, CommentObjectResponse[]>();
  const attachmentRefs: AttachmentRef[] = [];

  const log = (msg: string) => {
    console.log(`[notion-fetcher] ${msg}`);
    onProgress?.(msg);
  };

  // ── Step 1: Discover all pages via search ─────────────────────────────────

  log("Searching for pages…");
  let cursor: string | undefined;
  do {
    await rateLimit();
    const res = await notion.search({
      filter: { property: "object", value: "page" },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const result of res.results) {
      if (isFullPage(result)) {
        pages.set(result.id, result);
      }
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  // ── Step 2: Discover all data sources (databases) via search ──────────────

  log("Searching for databases…");
  cursor = undefined;
  do {
    await rateLimit();
    const res = await notion.search({
      filter: { property: "object", value: "data_source" },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const result of res.results) {
      if (isFullDataSource(result)) {
        pages.set(result.id, result);
      }
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  log(`Found ${pages.size} pages/databases`);

  // ── Step 3: Fetch data source rows (page children of data sources) ─────────

  const dataSourceIds = [...pages.values()]
    .filter((p) => p.object === "data_source")
    .map((p) => p.id);

  for (const dsId of dataSourceIds) {
    log(`Querying data source rows for ${dsId}…`);
    let rowCursor: string | undefined;
    do {
      await rateLimit();
      const res = await notion.dataSources.query({
        data_source_id: dsId,
        page_size: 100,
        ...(rowCursor ? { start_cursor: rowCursor } : {}),
      });
      for (const row of res.results) {
        if (isFullPage(row) && !pages.has(row.id)) {
          pages.set(row.id, row);
        }
      }
      rowCursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (rowCursor);
  }

  log(`Total after data source rows: ${pages.size} pages`);

  // ── Step 3b: Complete truncated list-shaped property values ────────────────
  // Page objects inline at most 25 items for relation/people/rich_text/title
  // properties. Relations flag the remainder with has_more at runtime; the
  // others truncate without a reliable flag (the typedefs omit has_more
  // entirely), so a full-length array of 25 is treated as possibly truncated
  // and completed through the property-item endpoint.
  const LIST_PROPERTY_TYPES = new Set(["relation", "people", "rich_text", "title"]);
  let completedProps = 0;
  for (const p of pages.values()) {
    if (p.object !== "page") continue;
    for (const prop of Object.values((p as { properties: Record<string, unknown> }).properties)) {
      const lp = prop as { type?: string; id?: string; has_more?: boolean } & Record<string, unknown>;
      if (!lp.type || !lp.id || !LIST_PROPERTY_TYPES.has(lp.type)) continue;
      const current = (lp[lp.type] as unknown[] | undefined) ?? [];
      if (lp.has_more !== true && current.length < 25) continue;
      try {
        const full: unknown[] = [];
        let propCursor: string | undefined;
        do {
          await rateLimit();
          const res = await notion.pages.properties.retrieve({
            page_id: p.id,
            property_id: lp.id,
            page_size: 100,
            ...(propCursor ? { start_cursor: propCursor } : {}),
          });
          if (!("results" in res)) break;
          for (const item of res.results) {
            const it = item as { type: string } & Record<string, unknown>;
            if (it.type === lp.type) full.push(it[it.type]);
          }
          propCursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
        } while (propCursor);
        if (full.length > current.length) {
          lp[lp.type] = full;
          lp.has_more = false;
          completedProps++;
        }
      } catch {
        // Keep the truncated 25 rather than failing the import over one
        // property; the summary line below makes the gap visible.
      }
    }
  }
  if (completedProps > 0) {
    log(`Completed ${completedProps} property values that exceeded Notion's 25-item cap`);
  }

  // ── Step 3c: Workspace user directory ──────────────────────────────────────
  // Resolves people/created_by values and comment authors to display names.
  // Integrations without user-read capability 403 here — names degrade to
  // whatever the property values carry inline.
  const userNames = new Map<string, string>();
  try {
    let userCursor: string | undefined;
    do {
      await rateLimit();
      const res = await notion.users.list({
        page_size: 100,
        ...(userCursor ? { start_cursor: userCursor } : {}),
      });
      for (const u of res.results) {
        if (u.name) userNames.set(u.id, u.name);
      }
      userCursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (userCursor);
    log(`User directory: ${userNames.size} users`);
  } catch {
    log("User directory unavailable (integration lacks user-read capability)");
  }

  // Untrusted-input guard: a hostile (or just enormous) shared selection must
  // not be able to OOM the worker or produce an unboundedly large payload.
  const MAX_IMPORT_PAGES = 5000;
  if (pages.size > MAX_IMPORT_PAGES) {
    throw new Error(
      `Import selection has ${pages.size} pages — the maximum is ${MAX_IMPORT_PAGES}. ` +
        `Share a smaller selection with the integration and retry.`,
    );
  }

  // ── Step 4: Fetch blocks for every page (recursive) ───────────────────────

  // Only real pages have block children — data_source ids are not block ids
  // and 404 on blocks.children.list (their description lives on the object
  // itself and is captured by the transformer).
  const pageIds = [...pages.values()]
    .filter((p) => p.object === "page")
    .map((p) => p.id);
  for (let i = 0; i < pageIds.length; i++) {
    const pageId = pageIds[i];
    if (i % 20 === 0) log(`Fetching blocks ${i + 1}/${pageIds.length}…`);
    // One unreadable page (unshared mid-run, restricted sub-block, API edge
    // case) must not kill a 600-page import — skip its body and continue.
    let pageBlocks: BlockObjectResponse[] = [];
    try {
      pageBlocks = await fetchBlocksRecursive(notion, pageId, rateLimit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`WARN: skipping blocks for page ${pageId}: ${msg}`);
    }
    blocks.set(pageId, pageBlocks);

    // Collect attachment refs from blocks
    for (const block of pageBlocks) {
      const refs = extractAttachmentRefsFromBlock(block, pageId);
      attachmentRefs.push(...refs);
    }
  }

  // ── Step 5: Collect attachment refs from data source page properties ───────

  for (const page of pages.values()) {
    if (page.object !== "page") continue;
    const refs = extractAttachmentRefsFromProperties(page as PageObjectResponse);
    attachmentRefs.push(...refs);
  }

  // ── Step 5b: Collect cover image refs from all pages and data sources ──────

  for (const page of pages.values()) {
    if (!page.cover) continue;
    const ref = extractFileRef(page.cover as NotionFile, page.id, "cover", "image/*");
    if (ref) attachmentRefs.push(ref);
  }

  // ── Step 6: Fetch comments for every page ─────────────────────────────────

  let commentMisses = 0;
  for (let i = 0; i < pageIds.length; i++) {
    const pageId = pageIds[i];
    if (i % 30 === 0) log(`Fetching comments ${i + 1}/${pageIds.length}…`);
    try {
      const pageComments: CommentObjectResponse[] = [];
      let commentCursor: string | undefined;
      do {
        await rateLimit();
        const res = await notion.comments.list({
          block_id: pageId,
          page_size: 100,
          ...(commentCursor ? { start_cursor: commentCursor } : {}),
        });
        pageComments.push(...(res.results as CommentObjectResponse[]));
        commentCursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
      } while (commentCursor);
      if (pageComments.length > 0) {
        comments.set(pageId, pageComments);
        // Comment attachments ride the same re-upload pipeline as block files.
        for (const c of pageComments) {
          for (const att of c.attachments ?? []) {
            if (att.file?.url) {
              attachmentRefs.push({
                notionUrl: att.file.url,
                pageId,
                filename: `comment-attachment.${att.category}`,
                mimeType: "",
                isExternal: false,
              });
            }
          }
        }
      }
    } catch {
      // The comments API 404s for pages whose discussions the integration
      // can't read; those pages import without comments.
      commentMisses += 1;
    }
  }
  log(
    `Comments: ${comments.size} page(s) with comments, ${commentMisses} inaccessible, ` +
      `${pageIds.length - comments.size - commentMisses} without comments`,
  );

  log(`Fetch complete. Pages: ${pages.size}, Attachment refs: ${attachmentRefs.length}`);

  return { pages, blocks, comments, attachmentRefs, userNames };
}

// ── Recursive block fetcher ───────────────────────────────────────────────────

async function fetchBlocksRecursive(
  notion: Client,
  blockId: string,
  rateLimit: () => Promise<void>
): Promise<BlockObjectResponse[]> {
  const result: BlockObjectResponse[] = [];
  let cursor: string | undefined;

  do {
    await rateLimit();
    const res = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });

    for (const block of res.results) {
      if (!isFullBlock(block)) continue;
      result.push(block);
      // Recurse for blocks that have children (but not child_page / child_database —
      // those are their own pages fetched as top-level entries)
      if (
        block.has_children &&
        block.type !== "child_page" &&
        block.type !== "child_database"
      ) {
        const children = await fetchBlocksRecursive(notion, block.id, rateLimit);
        result.push(...children);
      } else if (
        block.type === "synced_block" &&
        !block.has_children &&
        block.synced_block.synced_from?.block_id
      ) {
        // A duplicate synced block whose original lives elsewhere returns no
        // children of its own — pull the original's children and graft them
        // under the duplicate so the content survives the import.
        const originalId = block.synced_block.synced_from.block_id;
        try {
          const originals = await fetchBlocksRecursive(notion, originalId, rateLimit);
          for (const o of originals) {
            const parent = "parent" in o ? (o.parent as { block_id?: string }) : null;
            if (parent?.block_id === originalId) parent.block_id = block.id;
          }
          result.push(...originals);
        } catch {
          // Original not shared with the integration — the transformer emits
          // a placeholder for the empty synced block.
        }
      }
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return result;
}

// ── Attachment ref extraction ─────────────────────────────────────────────────

function extractAttachmentRefsFromBlock(
  block: BlockObjectResponse,
  pageId: string
): AttachmentRef[] {
  const refs: AttachmentRef[] = [];

  if (block.type === "image") {
    const ref = extractFileRef(block.image as NotionFile, pageId, "", "image/*");
    if (ref) refs.push(ref);
  } else if (block.type === "file") {
    const ref = extractFileRef(block.file as NotionFile, pageId, "", "application/octet-stream");
    if (ref) refs.push(ref);
  } else if (block.type === "pdf") {
    const ref = extractFileRef(block.pdf as NotionFile, pageId, "document.pdf", "application/pdf");
    if (ref) refs.push(ref);
  } else if (block.type === "video") {
    const ref = extractFileRef(block.video as NotionFile, pageId, "", "video/*");
    if (ref) refs.push(ref);
  } else if (block.type === "audio") {
    const ref = extractFileRef(block.audio as NotionFile, pageId, "", "audio/*");
    if (ref) refs.push(ref);
  }

  return refs;
}

function extractAttachmentRefsFromProperties(page: PageObjectResponse): AttachmentRef[] {
  const refs: AttachmentRef[] = [];

  for (const prop of Object.values(page.properties)) {
    if (prop.type !== "files") continue;
    for (const f of prop.files) {
      const ref = extractFileRef(f as unknown as NotionFile, page.id, "name" in f ? f.name : "", "application/octet-stream");
      if (ref) refs.push(ref);
    }
  }

  return refs;
}

// Re-export types for the transformer
export type { PageObjectResponse, DataSourceObjectResponse, BlockObjectResponse, CommentObjectResponse, RichTextItemResponse };
export { extractPlainText };
