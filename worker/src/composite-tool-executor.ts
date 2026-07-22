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

import type { ConnLike, ToolCallContext } from "./tools.js";
import { StaticToolExecutor } from "./tools.js";
import {
  McpToolExecutor,
  type McpClientFactory,
} from "./mcp-tool-executor.js";
import { PermissionChecker, type PermissionActionTag } from "./permission-checker.js";
import { AuditLogger, type AuditOutcome } from "./audit-logger.js";
import type { ToolDef } from "./providers.js";

// ── Configuration ─────────────────────────────────────────────────────────────

export interface CompositeToolExecutorConfig {
  conn: ConnLike;
  conversationId?: bigint;
  agentId: string;
  /** The page the current conversation is attached to — used for scope checks. */
  currentPageId?: bigint;
  jobId?: bigint;
  taskId?: bigint;
  /** Static definitions exposed on this surface (chat and Orcha differ). */
  staticTools: ToolDef[];
  /** Secrets and attribution metadata required by built-in tools. */
  toolContext?: ToolCallContext;
  /** Module-publisher connection used only for MCP secrets, health, and audit. */
  mcpRuntimeConn?: ConnLike;
  /** Test seam for the protocol client; production always uses McpClient. */
  mcpClientFactory?: McpClientFactory;
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

/**
 * Heuristic — true for tools known to mutate page content / structure /
 * properties. Kept conservative so we under-snapshot rather than over-
 * snapshot. Read-only or auxiliary tools (search, fetch, list) skip the
 * bracket entirely.
 */
function isMutatingPageTool(toolName: string): boolean {
  const lc = toolName.toLowerCase();
  if (lc.includes("snapshot")) return false;
  if (lc.includes("search") || lc.includes("fetch") || lc.startsWith("list_")) {
    return false;
  }
  return (
    lc.startsWith("update_") ||
    lc.startsWith("create_") ||
    lc.startsWith("delete_") ||
    lc.startsWith("set_") ||
    lc.startsWith("clear_") ||
    lc.startsWith("move_") ||
    lc.includes("save_yjs")
  );
}

/**
 * Pull a `pageId` (or `page_id`) out of the tool input, accepting either a
 * number / string / bigint encoding. Falls back to undefined; the caller
 * defaults to `currentPageId` when this returns nothing.
 */
function extractTargetPageId(input: Record<string, unknown>): bigint | undefined {
  const candidates = [input.pageId, input.page_id];
  for (const v of candidates) {
    if (typeof v === "bigint") return v;
    if (typeof v === "number") return BigInt(Math.trunc(v));
    if (typeof v === "string" && /^\d+$/.test(v)) {
      try {
        return BigInt(v);
      } catch {
        // fall through
      }
    }
  }
  return undefined;
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
    this.permissionChecker = new PermissionChecker(
      config.conn,
      mcpExecutor.getPermissionRows(),
    );
    this.auditLogger = new AuditLogger(config.mcpRuntimeConn ?? config.conn);
  }

  /**
   * Build a CompositeToolExecutor.
   * Connects MCP servers and checks for static/MCP tool name collisions.
   */
  static async create(config: CompositeToolExecutorConfig): Promise<CompositeToolExecutor> {
    const staticToolContext: ToolCallContext = {
      ...config.toolContext,
      conversationId: config.conversationId ?? config.toolContext?.conversationId,
      currentPageId: config.currentPageId ?? config.toolContext?.currentPageId,
    };
    const staticExecutor = new StaticToolExecutor(
      config.conn,
      config.jobId ?? BigInt(0),
      config.staticTools,
      staticToolContext,
    );

    const mcpExecutor = await McpToolExecutor.create(
      config.mcpRuntimeConn ?? config.conn,
      config.mcpClientFactory,
    );

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
      const staticToolContext: ToolCallContext = {
        ...this.config.toolContext,
        conversationId:
          this.config.conversationId ?? this.config.toolContext?.conversationId,
        currentPageId:
          this.config.currentPageId ?? this.config.toolContext?.currentPageId,
      };

      if (toolName === "tool_bash" && this.config.installedExtensionId !== undefined) {
        const wanted = (input.device_id ?? input.deviceId) as unknown;
        const toBigInt = (v: unknown): bigint | undefined => {
          if (typeof v === "bigint") return v;
          if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
          if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
          return undefined;
        };

        const explicit = toBigInt(wanted);
        if (explicit !== undefined) {
          const resolved = this.permissionChecker.resolveBridgeDevice(this.config.installedExtensionId);
          if (resolved.ok && resolved.deviceId !== explicit) {
            return JSON.stringify({
              ok: false,
              error: `Permission denied: device_id ${explicit} is not permitted for this extension`,
            });
          }
          if (!resolved.ok && resolved.candidates && !resolved.candidates.some((d) => d === explicit)) {
            return JSON.stringify({
              ok: false,
              error: `Permission denied: device_id ${explicit} is not in granted BridgeDevice scopes`,
            });
          }
        } else {
          const resolved = this.permissionChecker.resolveBridgeDevice(this.config.installedExtensionId);
          if (!resolved.ok) {
            return JSON.stringify({ ok: false, error: `Permission denied: ${resolved.reason}` });
          }
          input.device_id = Number(resolved.deviceId);
        }
      }

      return this.bracketWithSnapshots(toolName, input, () =>
        this.staticExecutor.execute(toolName, input, staticToolContext),
      );
    }

    // MCP tool — permission check required
    if (this.mcpExecutor.hasTool(toolName)) {
      const installedExtensionId = this.mcpExecutor.installedExtensionIdForTool(toolName);
      if (installedExtensionId === undefined) {
        return JSON.stringify({
          ok: false,
          error: `MCP tool has no owning extension: ${toolName}`,
        });
      }
      return this.bracketWithSnapshots(toolName, input, () =>
        this.executeMcpTool(toolName, input, installedExtensionId),
      );
    }

    return JSON.stringify({ ok: false, error: `Unknown tool: ${toolName}` });
  }

  /**
   * Wrap a tool execution in `PreAgentEdit` / `PostAgentEdit` snapshots when
   * the tool is known to mutate page state (Phase A diff review surface).
   *
   * Snapshot pairs let the editor render a `PendingChange` view with
   * Accept / Reject controls — Reject calls `restore_page_to_snapshot(pre)`.
   * We do this here rather than per-tool so a missed wiring in any single
   * mutator can't silently break the review surface.
   *
   * Snapshot calls never block the tool: failures are logged and swallowed
   * because most tool failures we'd otherwise want to roll back into would
   * already have a Pre snapshot.
   */
  private async bracketWithSnapshots(
    toolName: string,
    input: Record<string, unknown>,
    run: () => Promise<string>,
  ): Promise<string> {
    if (!isMutatingPageTool(toolName)) return run();

    const targetPageId = extractTargetPageId(input) ?? this.config.currentPageId;
    if (targetPageId === undefined) return run();

    let preSnapshotId: bigint | undefined;
    try {
      // We don't have the actual page content here; the reducer reads it
      // from `page.content` itself. For Yjs-backed pages the canonical state
      // lives in `page.yjsState`, which `take_snapshot` reads directly.
      await this.config.conn.reducers.takeSnapshot({
        pageId: targetPageId,
        snapshotType: { tag: "PreAgentEdit" } as never,
      });
      // The row id is discoverable via the `page_snapshot` table
      // subscription; the diff UI pairs Pre→Post by `snapshot_at` ordering
      // scoped to a page.
      void preSnapshotId;
    } catch (err) {
      console.warn(
        `[composite] PreAgentEdit snapshot failed for ${toolName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    const result = await run();

    try {
      await this.config.conn.reducers.takeSnapshot({
        pageId: targetPageId,
        snapshotType: { tag: "PostAgentEdit" } as never,
      });
    } catch (err) {
      console.warn(
        `[composite] PostAgentEdit snapshot failed for ${toolName}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    return result;
  }

  /** Disconnect all MCP connections (call when the conversation ends). */
  async disconnect(): Promise<void> {
    await this.mcpExecutor.disconnect();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async executeMcpTool(
    toolName: string,
    input: Record<string, unknown>,
    installedExtensionId: bigint,
  ): Promise<string> {
    const rawInput = JSON.stringify(input);
    const { currentPageId, conversationId, agentId, jobId, taskId } = this.config;

    // Permission check
    const action = requiredAction(toolName);

    let checkResult: { allowed: boolean; reason?: string };
    if (action === "HttpOutbound") {
      const url = (input.url as string | undefined) ?? "";
      checkResult = this.permissionChecker.checkHttpOutbound(installedExtensionId, url);
    } else {
      checkResult = this.permissionChecker.check(
        installedExtensionId,
        currentPageId ?? BigInt(0),
        action,
      );
    }

    if (!checkResult.allowed) {
      const reason = checkResult.reason ?? "Permission denied";
      void this.auditLogger.log({
        conversationId: conversationId ?? BigInt(0),
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
    void this.auditLogger.log({
      conversationId: conversationId ?? BigInt(0),
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

    if (outcome === "error") {
      return JSON.stringify({ ok: false, error: rawOutput });
    }

    return rawOutput;
  }
}
