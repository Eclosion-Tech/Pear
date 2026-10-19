/**
 * AuditLogger — writes ToolCallAuditLog rows to SpacetimeDB for every
 * tool call attempted by an extension (allowed, denied, or error).
 *
 * Design invariants:
 *   - Audit failures are logged to console but NEVER propagate as errors.
 *     A broken audit trail must not block tool execution — the alternative
 *     (silently skipping audit) is worse than execution failure.
 *   - Input and output are SHA-256 hashed in the private audit table. These
 *     digests identify content; they are not anonymization or public telemetry.
 *   - Outcome details are fixed host codes, never tool responses or errors.
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
}

const OUTCOME_DETAIL: Record<AuditOutcome, string> = {
  allowed: "tool_allowed",
  denied: "permission_denied",
  error: "tool_execution_failed",
};

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
        // Never accept a free-text detail, including from older JS callers.
        // Error messages and denial reasons can contain URLs, credentials and
        // tool-controlled response bodies.
        outcomeDetail: OUTCOME_DETAIL[entry.outcome],
      });
    } catch {
      // The reducer/transport error may echo the entire audit request.
      console.error("[audit] audit_write_failed");
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
