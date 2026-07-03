/**
 * Public entry for the platform-agnostic Pear MCP core.
 *
 * Imported by:
 *   - The pear worker's stdio + HTTP MCP hosts (`worker/src/mcp/`).
 *   - The Pear-Cloud Cloudflare gateway (`workers/api`) at
 *     `https://{slug}.api.pear.pro/mcp`.
 *
 * Anything not re-exported here is considered internal and may change.
 */

export { createPearMcpServer, SERVER_INFO } from "./server";
export { buildToolRegistry } from "./tools";
export { resolveAiUser } from "./identity";
export { McpAuthError, type McpContext, type McpToolEntry } from "./types";
export { HttpStdbTransport, type StdbTransport } from "../api-endpoint";
// Re-exported so external consumers (the CF gateway) resolve the SDK from
// THIS package's node_modules — one bundled copy, no version skew with the
// Server instances createPearMcpServer builds.
export { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
