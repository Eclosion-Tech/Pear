/**
 * CompositeToolExecutor — orchestrates static native tools and MCP extension tools
 * behind a unified interface with permission checking and audit logging.
 *
 * Routing rules:
 *   - Static tools (StaticToolExecutor) always win over MCP tools on name collision.
 *     A startup-time collision check logs an error for any MCP tool shadowed by a static one.
 *   - MCP tools are routed to McpToolExecutor.
 *   - Any unknown tool returns an error result (never throws).
 *
 * Per-call flow:
 *   1. Determine which executor owns the tool (static or MCP).
 *   2. For MCP tools: check ExtensionPermission via PermissionChecker.
 *   3. Execute the tool.
 *   4. Write an audit log entry via AuditLogger.
 *   5. Return the result to the caller.
 *
 * The CompositeToolExecutor is instantiated per conversation or job —
 * not as a long-lived singleton — so the permission snapshot is fresh.
 */

import type { ConnLike } from "./tools.js";
import { StaticToolExecutor } from "./tools.js";
import { McpToolExecutor } from "./mcp-tool-executor.js";
import { PermissionChecker, type PermissionActionTag } from "./permission-checker.js";
import { AuditLogger, type AuditOutcome } from "./audit-logger.js";
import type { ToolDef } from "./providers.js";

// ── Configuration ─────────────────────────────────────────────────────────────

export interface CompositeToolExecutorConfig {
  conn: ConnLike;
  conversationId: bigint;
  agentId: string;
  /** The page the current conversation is attached to — used for scope checks. */
  currentPageId: bigint;
  jobId?: bigint;
  taskId?: bigint;
  /**
   * If set, MCP tool calls are scoped to the installed extension with this id
   * and permission-checked against ExtensionPermission rows.
   */
  installedExtensionId?: bigint;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Map a tool name to the PermissionAction required to call it.
 * Only relevant for MCP tools — static tools are always permitted.
 */
function requiredAction(toolName: string): PermissionActionTag {
  if (toolName.includes("delete") || toolName.includes("purge")) return "Delete";
  if (toolName.includes("snapshot")) return "Snapshot";
  if (toolName.includes("property_write") || toolName.includes("set_property")) return "PropertyWrite";
  if (toolName.includes("property_read") || toolName.includes("list_propert")) return "PropertyRead";
  if (toolName.includes("fetch_url") || toolName.includes("http")) return "HttpOutbound";
  if (toolName.includes("spawn") || toolName.includes("job")) return "SpawnJob";
  if (toolName.includes("create") || toolName.includes("update") || toolName.includes("write")) return "Write";
  return "Read";
}

// ── CompositeToolExecutor ─────────────────────────────────────────────────────

export class CompositeToolExecutor {
  private readonly config: CompositeToolExecutorConfig;
  private readonly staticExecutor: StaticToolExecutor;
  private readonly mcpExecutor: McpToolExecutor;
  private readonly permissionChecker: PermissionChecker;
  private readonly auditLogger: AuditLogger;

  private constructor(
    config: CompositeToolExecutorConfig,
    staticExecutor: StaticToolExecutor,
    mcpExecutor: McpToolExecutor,
  ) {
    this.config = config;
    this.staticExecutor = staticExecutor;
    this.mcpExecutor = mcpExecutor;
    this.permissionChecker = new PermissionChecker(config.conn);
    this.auditLogger = new AuditLogger(config.conn);
  }

  /**
   * Build a CompositeToolExecutor.
   * Connects MCP servers and checks for static/MCP tool name collisions.
   */
  static async create(config: CompositeToolExecutorConfig): Promise<CompositeToolExecutor> {
    const staticExecutor = new StaticToolExecutor(config.conn, config.jobId ?? BigInt(0));

    const installedById =
      config.installedExtensionId !== undefined
        ? config.conn.db.installed_extension?.id?.find(config.installedExtensionId)
            ?.installedBy?.toHexString()
        : undefined;

    const mcpExecutor = await McpToolExecutor.create(config.conn, installedById);

    // Startup collision check: static wins, log errors for shadowed MCP tools
    const staticNames = staticExecutor.toolNames();
    for (const mcpToolDef of mcpExecutor.getToolDefs()) {
      if (staticNames.has(mcpToolDef.name)) {
        console.error(
          `[composite] Tool name collision: MCP tool "${mcpToolDef.name}" is shadowed by ` +
            `a static native tool. Static tool wins — MCP tool will not be callable.`,
        );
      }
    }

    return new CompositeToolExecutor(config, staticExecutor, mcpExecutor);
  }

  /**
   * Return all tool definitions for the LLM — static tools + non-colliding MCP tools.
   */
  getToolDefs(): ToolDef[] {
    const staticNames = this.staticExecutor.toolNames();
    const mcpDefs = this.mcpExecutor
      .getToolDefs()
      .filter((t) => !staticNames.has(t.name));

    // StaticToolExecutor delegates to getConversationTools for the ToolDef list
    // We can't easily get ToolDef[] from StaticToolExecutor here without importing
    // from tools.ts — return MCP defs only since static defs are passed separately.
    return mcpDefs;
  }

  /**
   * Execute a tool call.
   *
   * For static tools: executes immediately with no permission check.
   * For MCP tools: checks ExtensionPermission, executes if allowed, writes audit log.
   * Unknown tools: returns an error string without throwing.
   */
  async execute(toolName: string, input: Record<string, unknown>): Promise<string> {
    // Static tools always win and need no permission check
    if (this.staticExecutor.hasTool(toolName)) {
      return this.staticExecutor.execute(toolName, input);
    }

    // MCP tool — permission check required
    if (this.mcpExecutor.hasTool(toolName)) {
      return this.executeMcpTool(toolName, input);
    }

    return JSON.stringify({ ok: false, error: `Unknown tool: ${toolName}` });
  }

  /** Disconnect all MCP connections (call when the conversation ends). */
  async disconnect(): Promise<void> {
    await this.mcpExecutor.disconnect();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async executeMcpTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const rawInput = JSON.stringify(input);
    const { installedExtensionId, currentPageId, conversationId, agentId, jobId, taskId } =
      this.config;

    // Permission check
    if (installedExtensionId !== undefined) {
      const action = requiredAction(toolName);

      let checkResult: { allowed: boolean; reason?: string };
      if (action === "HttpOutbound") {
        const url = (input.url as string | undefined) ?? "";
        checkResult = this.permissionChecker.checkHttpOutbound(installedExtensionId, url);
      } else {
        checkResult = this.permissionChecker.check(installedExtensionId, currentPageId, action);
      }

      if (!checkResult.allowed) {
        const reason = checkResult.reason ?? "Permission denied";
        void this.auditLogger.log({
          conversationId,
          jobId,
          taskId,
          agentId,
          installedExtensionId,
          toolName,
          rawInput,
          rawOutput: reason,
          outcome: "denied",
          outcomeDetail: reason,
        });
        return JSON.stringify({ ok: false, error: `Permission denied: ${reason}` });
      }
    }

    // Execute
    let outcome: AuditOutcome = "allowed";
    let outcomeDetail: string | undefined;
    let rawOutput: string;

    try {
      rawOutput = await this.mcpExecutor.executeTool(toolName, input);
    } catch (err) {
      rawOutput = err instanceof Error ? err.message : String(err);
      outcome = "error";
      outcomeDetail = rawOutput;
    }

    // Audit log — never throws
    if (installedExtensionId !== undefined) {
      void this.auditLogger.log({
        conversationId,
        jobId,
        taskId,
        agentId,
        installedExtensionId,
        toolName,
        rawInput,
        rawOutput,
        outcome,
        outcomeDetail,
      });
    }

    if (outcome === "error") {
      return JSON.stringify({ ok: false, error: rawOutput });
    }

    return rawOutput;
  }
}
