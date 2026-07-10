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

import type { StdbTransport } from "../api-endpoint";

export type { StdbTransport };

/** Everything a tool needs to execute: a token-bound transport + identity. */
export interface McpContext {
  transport: StdbTransport;
  /** The AI user acting on this connection (resolved from ai_user_config). */
  aiUserId: bigint;
}

/** One MCP tool: JSON-Schema surface + stateless executor. */
export interface McpToolEntry {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
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
