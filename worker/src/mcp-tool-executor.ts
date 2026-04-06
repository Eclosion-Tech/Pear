/**
 * McpToolExecutor — loads all enabled ExtensionMcpServer rows from SpacetimeDB,
 * connects clients, and routes tool calls to the correct server.
 *
 * Routing rules (resolved at startup, not per-call):
 *   - Tool name collision between MCP servers: first-registered wins (lower server.id).
 *     This is deterministic and stable across restarts.
 *   - Collision with a static tool from StaticToolExecutor: static always wins.
 *     The CompositeToolExecutor is responsible for enforcing that boundary.
 *
 * Trust boundary:
 *   - Results are wrapped in a sentinel header by McpClient.callTool().
 *   - The CompositeToolExecutor's AuditLogger hashes input/output for the audit trail.
 */

import type { ConnLike } from "./tools.js";
import type { ToolDef } from "./providers.js";
import { McpClient, type McpServerConfig } from "./mcp-client.js";

// ── SpacetimeDB row types (private table — not in bindings) ───────────────────

type ExtensionMcpServerRow = {
  id: bigint;
  name: string;
  endpoint: string;
  authScheme: { tag: string };
  apiKey: string | undefined;
  capabilities: string[];
  installedBy: { toHexString(): string };
  enabled: boolean;
};

// ── McpToolExecutor ───────────────────────────────────────────────────────────

export class McpToolExecutor {
  /**
   * Maps tool name → the McpClient that owns it.
   * First-registered wins on collision (lower server.id).
   */
  private readonly toolMap = new Map<string, McpClient>();
  private readonly clients: McpClient[] = [];

  private constructor() {}

  /**
   * Build and connect a McpToolExecutor from the local SpacetimeDB cache.
   *
   * Loads all ExtensionMcpServer rows where enabled=true, creates clients,
   * connects each one, and builds the tool routing map.
   *
   * NOTE: ExtensionMcpServer is a private table. In the worker context the
   * conn.db has access to private table rows via the server-side subscription.
   * If access is restricted, this returns an empty executor gracefully.
   */
  static async create(conn: ConnLike, installedBy?: string): Promise<McpToolExecutor> {
    const executor = new McpToolExecutor();

    let serverRows: ExtensionMcpServerRow[];
    try {
      serverRows = [
        ...(conn.db.extension_mcp_server?.iter() as Iterable<ExtensionMcpServerRow> | undefined ?? []),
      ].filter(
        (s) =>
          s.enabled &&
          (installedBy === undefined || s.installedBy.toHexString() === installedBy),
      );
    } catch {
      console.warn("[mcp] extension_mcp_server table not accessible — MCP tools disabled");
      return executor;
    }

    // Sort by id ascending so first-registered wins on tool name collision
    serverRows.sort((a, b) => Number(a.id - b.id));

    for (const row of serverRows) {
      const config: McpServerConfig = {
        serverId: row.id,
        name: row.name,
        endpoint: row.endpoint,
        apiKey: row.apiKey,
        capabilities: row.capabilities,
      };

      const client = new McpClient(config);
      try {
        await client.connect();
        executor.clients.push(client);

        // Register tools — first-registered wins on name collision
        for (const tool of client.getTools()) {
          if (executor.toolMap.has(tool.name)) {
            const existing = executor.toolMap.get(tool.name)!;
            console.error(
              `[mcp] Tool name collision: "${tool.name}" declared by ` +
                `server "${row.name}" conflicts with server "${existing.config.name}". ` +
                `First-registered (${existing.config.name}) wins — "${row.name}" tool is skipped.`,
            );
          } else {
            executor.toolMap.set(tool.name, client);
          }
        }

        console.log(
          `[mcp] Connected to "${row.name}" (${client.getTools().length} tools available)`,
        );
      } catch (err) {
        console.error(
          `[mcp] Failed to connect to server "${row.name}" at ${row.endpoint}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return executor;
  }

  /** Returns true if any MCP server has registered a tool with this name. */
  hasTool(name: string): boolean {
    return this.toolMap.has(name);
  }

  /**
   * Execute a named MCP tool.
   * Throws if the tool name is not registered in any connected server.
   */
  async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    const client = this.toolMap.get(name);
    if (!client) {
      throw new Error(`MCP tool "${name}" is not registered in any connected server`);
    }
    return client.callTool(name, input);
  }

  /**
   * Return all MCP tools as ToolDef[] for inclusion in the LLM tool list.
   * Only tools routed through this executor (one per name) are included.
   */
  getToolDefs(): ToolDef[] {
    const defs: ToolDef[] = [];
    const seen = new Set<string>();

    for (const client of this.clients) {
      for (const tool of client.getTools()) {
        // Only include tools that won the routing lottery
        if (!seen.has(tool.name) && this.toolMap.get(tool.name) === client) {
          seen.add(tool.name);
          defs.push({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          });
        }
      }
    }

    return defs;
  }

  /** All capability strings across all connected servers (union). */
  get capabilities(): string[] {
    return [...new Set(this.clients.flatMap((c) => c.config.capabilities))];
  }

  /** Disconnect all MCP server connections. */
  async disconnect(): Promise<void> {
    await Promise.allSettled(this.clients.map((c) => c.disconnect()));
  }
}
