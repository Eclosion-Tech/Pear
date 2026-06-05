/**
 * Persisted shape of a tool call in `conversation_message.tool_calls_json`.
 *
 * One record per tool call, carrying everything its consumers need:
 *   - `session-reconstruct.ts` rebuilds the paired assistant `tool_use` + user
 *     `tool_result` blocks from `id` / `input` / `output` so the model resumes
 *     with a faithful record of what it did (assessment #1).
 *   - the action receipt / chat UI render `status` + `affected` entity refs (#32).
 *
 * Earlier builds persisted a leaner `{ name, status, result }` shape with no
 * `type` / `id` (see `LegacyToolCallInfo`). Those rows can't be re-paired (no
 * tool_use id to match a tool_result against), so the reconstructor falls back
 * to text-only for them. New rows always carry `type: "tool_use"`.
 */

/** Concrete entities a mutating tool touched, for verification + deep-linking (#32). */
export interface AffectedEntities {
  pageId?: number;
  createdNodeIds?: number[];
  propertyDefinitionId?: number;
  jobId?: number;
}

export interface StoredToolCall {
  type: "tool_use";
  /** Provider-assigned tool_use id — pairs the assistant call with its result. */
  id: string;
  name: string;
  /** `JSON.stringify` of the tool input object (capped). */
  input: string;
  status: "executing" | "done" | "error";
  /** Tool result string (capped). Absent if the turn ended before the result. */
  output?: string;
  isError?: boolean;
  affected?: AffectedEntities;
}

/** Legacy persisted shape (pre-#1). Read-only — never written by current code. */
export interface LegacyToolCallInfo {
  name: string;
  status: "executing" | "done" | "error";
  result?: string;
}

export const MAX_STORED_INPUT_CHARS = 4_000;
export const MAX_STORED_OUTPUT_CHARS = 8_000;

/** Truncate a string to `max` chars (no-op if already shorter). */
export function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Type guard: is a parsed `tool_calls_json` entry the unified shape? */
export function isStoredToolCall(x: unknown): x is StoredToolCall {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { type?: unknown }).type === "tool_use" &&
    typeof (x as { id?: unknown }).id === "string"
  );
}

/**
 * Pull known affected-entity references out of a tool result JSON string (#32).
 * Parses the *full* result (not a display-truncated snippet), so counts like
 * `created_node_ids.length` are accurate. Returns undefined when nothing known
 * is present (e.g. a failed call or a read-only tool).
 */
export function extractAffected(result: string | undefined): AffectedEntities | undefined {
  if (!result) return undefined;
  let p: Record<string, unknown>;
  try {
    const parsed = JSON.parse(result);
    if (!parsed || typeof parsed !== "object") return undefined;
    p = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const a: AffectedEntities = {};
  if (typeof p.page_id === "number") a.pageId = p.page_id;
  if (typeof p.property_definition_id === "number") a.propertyDefinitionId = p.property_definition_id;
  if (typeof p.job_id === "number") a.jobId = p.job_id;
  if (Array.isArray(p.created_node_ids)) {
    const ids = p.created_node_ids.filter((x): x is number => typeof x === "number");
    if (ids.length > 0) a.createdNodeIds = ids;
  }
  return Object.keys(a).length > 0 ? a : undefined;
}
