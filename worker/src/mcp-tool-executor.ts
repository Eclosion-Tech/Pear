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
import type { ExtensionPermissionRow } from "./permission-checker.js";

// ── SpacetimeDB caller-scoped runtime view types ──────────────────────────────

type AiExtensionRuntimePermissionRow = {
  scope: ExtensionPermissionRow["scope"];
  action: ExtensionPermissionRow["action"];
  allowedDomains: string | undefined;
};

type AiExtensionRuntimeRow = {
  installedExtensionId: bigint;
  serverId: bigint;
  name: string;
  endpoint: string;
  authScheme: { tag: string };
  apiKey: string | undefined;
  capabilities: string[];
  permissions: AiExtensionRuntimePermissionRow[];
};

type ToolBinding = {
  client: McpClientLike;
  installedExtensionId: bigint;
};

type McpClientLike = Pick<
  McpClient,
  "config" | "connect" | "disconnect" | "getTools" | "callTool"
>;

export type McpClientFactory = (config: McpServerConfig) => McpClientLike;

// ── McpToolExecutor ───────────────────────────────────────────────────────────

export class McpToolExecutor {
  /**
   * Maps tool name → the McpClient that owns it.
   * First-registered wins on collision (lower server.id).
   */
  private readonly toolMap = new Map<string, ToolBinding>();
  private readonly clients: McpClientLike[] = [];
  private readonly permissions: ExtensionPermissionRow[] = [];

  private constructor() {}

  /**
   * Build and connect a McpToolExecutor from the local SpacetimeDB cache.
   *
   * Loads all ExtensionMcpServer rows where enabled=true, creates clients,
   * connects each one, and builds the tool routing map.
   *
   * NOTE: ExtensionMcpServer is a private table. In the worker context the
   * The server-side view returns rows only to a managed AI-user identity. If
   * access is restricted, this returns an empty executor gracefully.
   */
  static async create(
    conn: ConnLike,
    clientFactory: McpClientFactory = (config) => new McpClient(config),
  ): Promise<McpToolExecutor> {
    const executor = new McpToolExecutor();

    let serverRows: AiExtensionRuntimeRow[];
    try {
      serverRows = [
        ...(conn.db.ai_extension_runtime?.iter() as
          | Iterable<AiExtensionRuntimeRow>
          | undefined ?? []),
      ];
    } catch {
      console.warn("[mcp] ai_extension_runtime view not accessible — MCP tools disabled");
      return executor;
    }

    // Sort by id ascending so first-registered wins on tool name collision
    serverRows.sort((a, b) => Number(a.serverId - b.serverId));

    for (const row of serverRows) {
      executor.permissions.push(
        ...row.permissions.map((permission) => ({
          installedExtensionId: row.installedExtensionId,
          scope: permission.scope,
          action: permission.action,
          allowedDomains: permission.allowedDomains,
        })),
      );

      await reportHealth(conn, row.installedExtensionId, "Connecting", 0);
      const config: McpServerConfig = {
        serverId: row.serverId,
        name: row.name,
        endpoint: row.endpoint,
        authScheme: row.authScheme.tag,
        apiKey: row.apiKey,
        capabilities: row.capabilities,
      };

      const client = clientFactory(config);
      try {
        await client.connect();
        executor.clients.push(client);
        let registeredToolCount = 0;

        // Register tools — first-registered wins on name collision
        for (const tool of client.getTools()) {
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) {
            console.error(
              `[mcp] Skipping invalid tool name from "${row.name}": ${JSON.stringify(tool.name)}`,
            );
            continue;
          }
          if (executor.toolMap.has(tool.name)) {
            const existing = executor.toolMap.get(tool.name)!.client;
            console.error(
              `[mcp] Tool name collision: "${tool.name}" declared by ` +
                `server "${row.name}" conflicts with server "${existing.config.name}". ` +
                `First-registered (${existing.config.name}) wins — "${row.name}" tool is skipped.`,
            );
          } else {
            executor.toolMap.set(tool.name, {
              client,
              installedExtensionId: row.installedExtensionId,
            });
            registeredToolCount += 1;
          }
        }

        await reportHealth(
          conn,
          row.installedExtensionId,
          "Connected",
          registeredToolCount,
        );
        console.log(
          `[mcp] Connected to "${row.name}" (${registeredToolCount} tools available)`,
        );
      } catch (err) {
        await client.disconnect().catch(() => undefined);
        const detail = err instanceof Error ? err.message : String(err);
        await reportHealth(conn, row.installedExtensionId, "Error", 0, detail);
        console.error(
          `[mcp] Failed to connect to server "${row.name}" at ${row.endpoint}: ` +
            detail,
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
    const binding = this.toolMap.get(name);
    if (!binding) {
      throw new Error(`MCP tool "${name}" is not registered in any connected server`);
    }
    return binding.client.callTool(name, input);
  }

  /** Installed extension that owns a routed tool. */
  installedExtensionIdForTool(name: string): bigint | undefined {
    return this.toolMap.get(name)?.installedExtensionId;
  }

  /** Permission snapshot delivered alongside the credential-bearing runtime view. */
  getPermissionRows(): readonly ExtensionPermissionRow[] {
    return this.permissions;
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
        if (!seen.has(tool.name) && this.toolMap.get(tool.name)?.client === client) {
          seen.add(tool.name);
          defs.push({
            name: tool.name,
            description: `[MCP extension: ${client.config.name}] ${tool.description}`.slice(0, 4_000),
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

async function reportHealth(
  conn: ConnLike,
  installedExtensionId: bigint,
  status: "Connecting" | "Connected" | "Error",
  toolCount: number,
  detail?: string,
): Promise<void> {
  try {
    await conn.reducers.reportExtensionRuntimeHealth({
      installedExtensionId,
      status: { tag: status },
      toolCount,
      detail,
    });
  } catch (err) {
    console.warn(
      `[mcp] Failed to report ${status.toLowerCase()} health for extension ${installedExtensionId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Proactively initialize/list tools for Settings health, then close clients. */
export async function probeMcpExtensions(conn: ConnLike): Promise<void> {
  const executor = await McpToolExecutor.create(conn);
  await executor.disconnect();
}
