/**
 * Shared types for the platform-agnostic Pear MCP core.
 *
 * Like the sibling `../api-endpoint` library, this package must run in
 * Node hosts (the pear worker's stdio/http entrypoints) AND in Cloudflare
 * Workers (the pear-cloud API gateway): no `node:*` imports, no
 * `process.env`, no Node-only globals. All SpacetimeDB access goes through
 * an injected {@link StdbTransport} bound to the CALLER's AI-user worker
 * token, so reducer writes are attributed and RLS-scoped to that AI user.
 */

import type { Tool } from "@modelcontextprotocol/server";
import type { StdbTransport } from "../api-endpoint";

export type { StdbTransport };

/** Everything a tool needs to execute: a token-bound transport + identity. */
export interface McpContext {
  transport: StdbTransport;
  /** The AI user acting on this connection (resolved from ai_user_config). */
  aiUserId: bigint;
  /** Present for native chat turns; lets history search omit the current chat. */
  conversationId?: bigint;
  /**
   * Host-provided reader for workspace blobs (page file/image/audio blocks,
   * File property cells, chat attachments). Absent on hosts without blob
   * storage access — `read_file` then reports the capability as unavailable
   * rather than guessing at bytes it cannot reach.
   */
  files?: WorkspaceFileReader;
}

/**
 * One workspace blob, fetched and (where the host can) reduced to text.
 *
 * Hosts own byte access AND extraction because both are platform-specific:
 * the worker reads S3 directly with the AWS SDK and runs PDF/DOCX extractors,
 * the Cloudflare gateway signs fetches by hand, and neither dependency set
 * belongs in this platform-agnostic core. The core only decides how to
 * present the result.
 */
export interface WorkspaceFile {
  /** The key as the caller supplied it (bare objectId or full S3 key). */
  storageKey: string;
  contentType?: string;
  byteSize: number;
  /**
   * Text content when the host could produce it: decoded UTF-8 for text-like
   * types, extracted text for documents. Undefined for binary formats the
   * host has no extractor for (the tool then returns metadata only).
   */
  text?: string;
  /** Which path produced `text` — e.g. "utf8", "pdf", "docx". */
  extractor?: string;
  /** Set when the host stopped extracting early (size cap / page cap). */
  textTruncated?: boolean;
  /** Host note for the caller when extraction was skipped or partial. */
  note?: string;
}

export interface WorkspaceFileReader {
  /**
   * Fetch a blob by storage key. Resolves `null` when the object does not
   * exist in THIS workspace (the key is only ever resolved inside the
   * caller's workspace prefix, so a foreign objectId is simply not found).
   * Throws on infrastructure failure.
   */
  read(storageKey: string): Promise<WorkspaceFile | null>;
}

/** One MCP tool: JSON-Schema surface + stateless executor. */
export interface McpToolEntry {
  name: string;
  description: string;
  /** JSON Schema for the tool input (the MCP `Tool.inputSchema` shape). */
  inputSchema: Tool["inputSchema"];
  /** Returns a JSON string; `{"ok":false,...}` marks a tool-level error. */
  execute: (ctx: McpContext, input: Record<string, unknown>) => Promise<string>;
}

/** Decoded `page` row (wire shapes normalized to plain JS). */
export interface PageRow {
  id: number;
  parentId: number | null;
  title: string;
  pageType: "Doc" | "Database";
  contentFormat: "BlockNote" | "ComponentTree";
  sortOrder: number;
  deleted: boolean;
  updatedAtMicros: number | null;
}

/** Decoded `component_node` row scoped to one surface (page). */
export interface ComponentNodeRow {
  id: number;
  parentId: number | null;
  componentType: string;
  props?: string;
  order: number;
  deleted: boolean;
}

/** Thrown when the bearer token does not belong to a Pear AI user. */
export class McpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAuthError";
  }
}
