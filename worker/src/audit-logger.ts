/**
 * AuditLogger — writes ToolCallAuditLog rows to SpacetimeDB for every
 * tool call attempted by an extension (allowed, denied, or error).
 *
 * Design invariants:
 *   - Audit failures are logged to console but NEVER propagate as errors.
 *     A broken audit trail must not block tool execution — the alternative
 *     (silently skipping audit) is worse than execution failure.
 *   - Input and output are SHA-256 hashed — raw content is never stored.
 *   - All calls are logged, including denied ones (outcome="denied").
 */

import type { ConnLike } from "./tools.js";
import { createHash } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AuditOutcome = "allowed" | "denied" | "error";

export interface AuditEntry {
  conversationId: bigint;
  jobId?: bigint;
  taskId?: bigint;
  agentId: string;
  installedExtensionId?: bigint;
  toolName: string;
  rawInput: string;
  rawOutput: string;
  outcome: AuditOutcome;
  outcomeDetail?: string;
}

// ── AuditLogger ───────────────────────────────────────────────────────────────

export class AuditLogger {
  private readonly conn: ConnLike;

  constructor(conn: ConnLike) {
    this.conn = conn;
  }

  /**
   * Write an audit log entry to SpacetimeDB.
   * Never throws — audit failures are swallowed and logged to console.
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      const inputHash = sha256Hex(entry.rawInput);
      const outputHash = sha256Hex(entry.rawOutput);

      await this.conn.reducers.recordToolCallAudit({
        conversationId: entry.conversationId,
        jobId: entry.jobId ?? undefined,
        taskId: entry.taskId ?? undefined,
        agentId: entry.agentId,
        installedExtensionId: entry.installedExtensionId ?? undefined,
        toolName: entry.toolName,
        inputHash,
        outputHash,
        outcome: entry.outcome,
        outcomeDetail: entry.outcomeDetail ?? undefined,
      });
    } catch (err) {
      console.error(
        `[audit] Failed to write audit log for tool "${entry.toolName}": `,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
