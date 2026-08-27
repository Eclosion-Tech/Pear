import {
  type InferenceProvider,
  type Message,
  type ToolUseBlock,
  type ToolDef,
  type TokenUsage,
  getDefaultProvider,
} from "./providers.js";
import {
  getPearTools,
  type ConnLike,
  type ToolCallContext,
} from "./tools.js";
import { CompositeToolExecutor } from "./composite-tool-executor.js";
import { SystemPromptBuilder } from "./prompt-builder.js";
import {
  cap,
  extractAffected,
  type StoredToolCall,
} from "./tool-call-record.js";
import {
  buildAiUserMemoryIndex,
  discoverAccessibleResources,
} from "./workspace-context.js";

let _defaults: { provider: InferenceProvider; model: string; plannerModel: string; maxTokens: number } | null = null;
function defaults() {
  if (!_defaults) _defaults = getDefaultProvider();
  return _defaults;
}

// ── Pear context injected into every LLM call ─────────────────────────────────

const PEAR_CONTEXT = `\
You are an AI assistant embedded in **Pear**, a self-hosted collaborative workspace.

Key architectural facts:
- Pear uses **SpacetimeDB** as its real-time relational backend. There is no traditional SQL database; everything is stored in SpacetimeDB tables (Rust structs compiled to WASM) and accessed via a TypeScript SDK on the client.
- Pages are the core content unit. A page has a \`page_type\`: either **"doc"** (rich text, edited in BlockNote) or **"database"** (structured rows with typed property columns).
- Database pages have a **DatabaseSchema** (columns called "properties") and **DatabaseView** configurations.
- File attachments are stored in S3-compatible object storage (MinIO by default).
- The frontend is **Next.js** with React. Realtime data comes from SpacetimeDB subscriptions, not REST/GraphQL.
- Reducers are the only way to mutate data (no raw SQL). New tables / columns require a Rust schema change + WASM rebuild.

When the user asks you to "build a database", "add a column", or "create a schema" — they mean within Pear's SpacetimeDB-backed pages/databases, NOT a standalone SQL database.`;

/**
 * Orcha-task-specific procedural tool rules. The shared, drift-prone content
 * (grounding rules, `next_step` guidance, injection defense, doing-tasks) is no
 * longer restated here — it comes from the one `SystemPromptBuilder` source via
 * `buildOrchaTaskSystem` (#18). Keep only what's genuinely Orcha-task-specific.
 */
const ORCHA_TOOL_RULES = `You are a BACKGROUND worker agent with NO interactive user. Nobody is reading your replies and there is no way to ask a question — any request for clarification is a dead end that silently fails the task. Therefore:
- NEVER ask for input, confirmation, or clarification. Everything you need is already in your task instructions; act on it.
- If some detail is genuinely missing, make a reasonable assumption, state it in one line, and proceed — do not stop and do not ask.
- Do the WHOLE task, not a shell of it. If the task is "create a page with this content", you must create the page AND write the content in this same task (call \`update_page_content\`). A page created with an empty body is NOT success.
- Only report completion for work you actually performed and verified via tool results. If you truly cannot finish (a required tool returned an error, or a hard prerequisite is absent), make your FINAL reply begin with "TASK_FAILED:" and one line on why — do not report success for work you did not do.

You have tools to directly create and modify pages in Pear. ALWAYS use tools to make changes — never just describe what the user should do manually.

Tool-use rules:
- When asked to create a database with columns: call \`create_page\` (type=Database) first — this also creates the schema. The result includes a \`schema_id\` and a \`next_step\` hint. You MUST then call \`add_property\` for EVERY specified column before writing your final summary. Never stop after just \`create_page\`.
- To add rows to a database: call \`list_properties\` (to get property_definition_ids), then \`create_row\` for each row (returns page_id), then \`set_property_value\` for each column value on that row. Repeat for every row.
- To write text into a Doc page: call \`update_page_content\` with a \`markdown\` string. Headings, bullet/numbered/checklist items, and paragraphs are supported, as are inline **bold**, *italic*, \`code\`, and [links](url). This replaces the page's existing content.
- When a task says "look up page_id from shared context": call \`get_context\` with the relevant key before doing anything else.
- When creating a page, use the current page's ID (from the "Current page" context) as parent_id to nest it there. Use 0 only if you want it at the workspace root.
- After creating any page that a sibling task will need, the page_id is automatically stored in shared context under the page title (lowercase, spaces replaced with underscores, e.g. "Task Tracker" → "task_tracker_page_id").
- Complete ALL steps the task specifies before returning your final text summary.
- Be concise in your final summary — just confirm what was done and any relevant IDs.`;

/** Single-sourced Orcha `llm`-task prompt — shared sections + Orcha specifics (#18). */
const SYSTEM_PROMPT = new SystemPromptBuilder().buildOrchaTaskSystem(
  PEAR_CONTEXT,
  ORCHA_TOOL_RULES,
);

// ── Page context helpers ───────────────────────────────────────────────────────

type PageRow = {
  id: bigint;
  title: string;
  pageType: { tag: string };
  deletedAt?: unknown;
};

type SnapshotRow = {
  pageId: bigint;
  content: string;
  snapshotAt: { microsSinceUnixEpoch: bigint };
};

type SchemaRow = {
  pageId: bigint;
  name: string;
};

/**
 * Build a text block describing the Pear page (title, type, latest content)
 * so the LLM has real workspace context rather than a blank slate.
 */
export async function buildPageContext(
  conn: ConnLike,
  pageId: bigint | undefined
): Promise<string> {
  if (!pageId) return "";

  const page = conn.db.page.id.find(pageId) as PageRow | undefined;
  if (!page) return "";

  const lines: string[] = [
    `Current page: "${page.title}" (type: ${page.pageType.tag}, page_id: ${page.id})`,
  ];

  if (page.pageType.tag === "Database") {
    const schema = conn.db.database_schema.iter() as Iterable<SchemaRow>;
    const cols: string[] = [];
    for (const s of schema) {
      if (s.pageId === pageId) cols.push(s.name);
    }
    if (cols.length) {
      lines.push(`Database columns: ${cols.join(", ")}`);
    }
  }

  if (page.pageType.tag === "Doc") {
    const snapshots = conn.db.page_snapshot.iter() as Iterable<SnapshotRow>;
    let latest: SnapshotRow | undefined;
    for (const s of snapshots) {
      if (s.pageId !== pageId) continue;
      if (!latest || s.snapshotAt.microsSinceUnixEpoch > latest.snapshotAt.microsSinceUnixEpoch) {
        latest = s;
      }
    }
    if (latest?.content) {
      const text = extractTextFromJson(latest.content).slice(0, 2000);
      if (text) lines.push(`Page content:\n${text}`);
    }
  }

  return lines.join("\n");
}

function extractTextFromJson(json: string): string {
  try {
    const blocks: unknown[] = JSON.parse(json);
    return extractTextFromBlocks(blocks);
  } catch {
    return "";
  }
}

function extractTextFromBlocks(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (Array.isArray(b.content)) {
      for (const inline of b.content as Array<Record<string, unknown>>) {
        if (typeof inline.text === "string") parts.push(inline.text);
      }
    }
    if (Array.isArray(b.children)) {
      parts.push(extractTextFromBlocks(b.children as unknown[]));
    }
  }
  return parts.filter(Boolean).join(" ");
}

// ── LLM calls ─────────────────────────────────────────────────────────────────

/**
 * Execute a single LLM task with tool use.
 *
 * The model is given tools for every Pear SpacetimeDB reducer it's allowed to
 * call. It decides which tools to invoke, the worker executes them, and results
 * are fed back so the model can reference newly-created IDs in subsequent calls.
 *
 * The loop continues until the model returns a plain text response (no more
 * tool calls), which becomes the task result shown in the AiPanel.
 *
 * Accepts an optional provider + model override for per-AI-user routing.
 * Falls back to the default (env-var configured) provider when not specified.
 */
/** Result of an Orcha `llm` task: the final text plus the real token usage
 * summed across the tool loop, so `record_usage_event` gets true counts (#3). */
export interface LlmResult {
  text: string;
  usage: TokenUsage;
  /** Set when the executor self-reported it could not complete (final reply
   * began with "TASK_FAILED:"), so the caller marks the task failed instead of
   * letting a blocked task report success. */
  failed?: boolean;
  /** Every tool call the loop made, in order, with capped input/output — the
   * task's execution trace. The worker persists it to the job's shared context
   * (`trace:task:<id>`) so the UI can show what a background job actually did. */
  toolCalls: StoredToolCall[];
}

/** Per-call caps for the persisted trace — tighter than a chat message's
 * `tool_calls_json` because a task can run up to MAX_ITERATIONS rounds. */
export const TRACE_INPUT_CHARS = 1_000;
export const TRACE_OUTPUT_CHARS = 2_000;
/** Calls beyond this are dropped from the trace (a marker call is appended). */
export const TRACE_MAX_CALLS = 60;

/** Serialize a trace for `orcha_shared_context`, dropping the tail if it grows
 * past TRACE_MAX_CALLS so a runaway loop can't write an unbounded row. */
export function serializeToolTrace(calls: StoredToolCall[]): string {
  if (calls.length <= TRACE_MAX_CALLS) return JSON.stringify(calls);
  const dropped = calls.length - TRACE_MAX_CALLS;
  return JSON.stringify([
    ...calls.slice(0, TRACE_MAX_CALLS),
    {
      type: "tool_use",
      id: "trace-truncated",
      name: "…",
      input: "{}",
      status: "done",
      output: `${dropped} more tool call${dropped === 1 ? "" : "s"} not recorded`,
    } satisfies StoredToolCall,
  ]);
}

/** Shared-context key under which a task's tool trace is stored. Readers that
 * feed shared context back into prompts must skip this prefix. */
export const TRACE_KEY_PREFIX = "trace:";
export function traceKeyForTask(taskId: bigint): string {
  return `${TRACE_KEY_PREFIX}task:${taskId}`;
}

/**
 * Context handed off from the delegating chat into a subagent's prompt: the AI
 * user's memory index and its granted pages, so the executor doesn't rely on the
 * delegator re-typing everything into the task description. Empty for non-AI-user
 * (human-initiated) jobs.
 */
function buildSubagentContext(conn: ConnLike, toolContext: ToolCallContext): string {
  if (toolContext.aiUserId === undefined) return "";
  const parts: string[] = [];
  try {
    const mem = buildAiUserMemoryIndex(conn, toolContext.aiUserId);
    if (mem.length > 0) {
      parts.push(
        "Your memory pages (open with read_memory):\n" +
          mem
            .slice(0, 30)
            .map((e) => `- ${e.title} (page ${e.pageId})${e.snippet ? `: ${e.snippet}` : ""}`)
            .join("\n"),
      );
    }
  } catch {
    /* memory not provisioned — fine */
  }
  if (toolContext.aiIdentityHex) {
    try {
      const grants = discoverAccessibleResources(conn, toolContext.aiIdentityHex);
      if (grants.length > 0) {
        parts.push(
          "Pages you have been granted access to:\n" +
            grants
              .slice(0, 30)
              .map((r) => `- ${r.title} (page ${r.pageId}, ${r.permission})`)
              .join("\n"),
        );
      }
    } catch {
      /* ignore */
    }
  }
  return parts.length
    ? `\n\n---\nContext from the delegating chat:\n${parts.join("\n\n")}`
    : "";
}

/** Append a compact artifacts footer (deep-linkable page ids the job touched) to
 * a task result, so the completion trigger and the delegator can point at them.
 * No-op when the job created/edited no pages. */
function appendArtifacts(text: string, pageIds: Set<number>): string {
  if (pageIds.size === 0) return text;
  const list = [...pageIds]
    .sort((a, b) => a - b)
    .map((id) => `page ${id}`)
    .join(", ");
  return `${text}\n\nArtifacts: ${list}`;
}

export async function callLlm(
  taskDescription: string,
  conn: ConnLike,
  jobId: bigint,
  extraContext = "",
  overrides?: { provider: InferenceProvider; model: string; maxTokens?: number },
  // Execution context for the tool loop. When a delegated job belongs to an AI
  // user, the caller passes that AI user's connection here so Pear mutation tools
  // run with the AI user's identity + access rules (governed), instead of the
  // admin `conn` used for reads. Defaults to `conn` for
  // human-initiated jobs, preserving prior behaviour.
  exec?: { conn: ConnLike; toolContext?: ToolCallContext },
): Promise<LlmResult> {
  const inf = overrides?.provider ?? defaults().provider;
  const model = overrides?.model ?? defaults().model;
  const maxTokens = overrides?.maxTokens ?? defaults().maxTokens;

  const execConn = exec?.conn ?? conn;
  const toolContext = exec?.toolContext ?? {};

  let userMessage = extraContext
    ? `${taskDescription}\n\n---\n${extraContext}`
    : taskDescription;
  userMessage += buildSubagentContext(execConn, toolContext);

  const messages: Message[] = [
    { role: "user", content: userMessage },
  ];

  // AI-attributed jobs get the AI user's read-only memory tools.
  const staticTools: ToolDef[] = getPearTools(execConn, jobId, {
    includeMemoryTools: toolContext.aiUserId !== undefined,
  }) as ToolDef[];
  const toolExecutor = await CompositeToolExecutor.create({
    conn: execConn,
    conversationId: toolContext.conversationId,
    currentPageId: toolContext.currentPageId,
    agentId: toolContext.aiIdentityHex ?? "orcha-worker",
    jobId,
    staticTools,
    toolContext,
    mcpRuntimeConn: conn,
  });
  const tools: ToolDef[] = [...staticTools, ...toolExecutor.getToolDefs()];

  // Page ids this job created/edited, surfaced as artifacts in the result.
  const artifactPageIds = new Set<number>();
  const trace: StoredToolCall[] = [];

  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  let iterations = 0;
  const MAX_ITERATIONS = 25;

  try {
    while (iterations++ < MAX_ITERATIONS) {
      const response = await inf.chat({
        model,
        maxTokens,
        system: SYSTEM_PROMPT,
        messages,
        tools,
      });

      if (response.usage) {
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        usage.cacheCreationInputTokens += response.usage.cacheCreationInputTokens;
        usage.cacheReadInputTokens += response.usage.cacheReadInputTokens;
      }

      const toolCalls = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use"
      );

      console.log(`[worker] LLM response — stop_reason=${response.stopReason} tool_calls=${toolCalls.length} content_blocks=${response.content.map((b) => b.type).join(",")}`);

      if (toolCalls.length === 0 || response.stopReason === "end_turn") {
        const textBlock = response.content.find((b) => b.type === "text");
        const summary = textBlock?.type === "text" ? textBlock.text : "Done.";
        const failed = /^\s*TASK_FAILED:/i.test(summary);
        return {
          text: appendArtifacts(summary, artifactPageIds),
          usage,
          failed,
          toolCalls: trace,
        };
      }

      messages.push({ role: "assistant", content: response.content });

      const toolResults: { type: "tool_result"; tool_use_id: string; content: string }[] = [];
      for (const block of toolCalls) {
        console.log(`[worker] Tool call [${block.name}]: ${JSON.stringify(block.input)}`);
        const result = await toolExecutor.execute(block.name, block.input);
        console.log(`[worker] Tool result [${block.name}]: ${result}`);
        const affected = extractAffected(result);
        if (affected?.pageId !== undefined) artifactPageIds.add(affected.pageId);
        trace.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: cap(JSON.stringify(block.input ?? {}), TRACE_INPUT_CHARS),
          status: isToolError(result) ? "error" : "done",
          output: cap(result, TRACE_OUTPUT_CHARS),
          isError: isToolError(result) || undefined,
          affected: affected ?? undefined,
        });
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }

      messages.push({ role: "user", content: toolResults });
    }

    return {
      text: appendArtifacts("Reached maximum tool iterations.", artifactPageIds),
      usage,
      toolCalls: trace,
    };
  } finally {
    await toolExecutor.disconnect();
  }
}

/** Pear tools answer `{ ok: false, error }` JSON on failure; anything else
 * (including non-JSON text from web/sandbox tools) counts as success. */
function isToolError(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as { ok?: unknown };
    return typeof parsed === "object" && parsed !== null && parsed.ok === false;
  } catch {
    return false;
  }
}

// ── Task planner ───────────────────────────────────────────────────────────────

export type TaskSpec = {
  description: string;
  task_type: string;
  depends_on: number[];
  required_capabilities: string[];
};

const PLANNER_SYSTEM = `\
${PEAR_CONTEXT}

You are the **task planner** for Pear's AI orchestration layer.

Given a user request (and optional page context), decompose it into a small list of atomic, actionable subtasks that make sense inside Pear. Submit the result by calling the \`submit_plan\` tool exactly once with the full task list — do not reply in prose.

Each task in the list is:
{ "description": string, "task_type": "llm" | "orchestrate", "depends_on": number[], "required_capabilities": string[] }

Rules:
- Use \`"task_type": "llm"\` for simple, self-contained tasks that a single LLM call can complete.
- Use \`"task_type": "orchestrate"\` with \`"required_capabilities": ["orchestrate"]\` for tasks that are themselves complex enough to need further breakdown (multi-step, ambiguous scope, or depend on the output of planning).
- Use \`"task_type": "llm"\` with \`"required_capabilities": ["llm"]\` for concrete execution tasks.
- "depends_on" contains zero-based indices of tasks in this array that must complete first.
- Keep the list small (1–5 tasks). For simple requests return a single \`llm\` task.
- Tasks should be Pear-specific — NOT generic SQL DDL or standalone database design.
- Do not include the current orchestration/planning step itself in the output.
- IMPORTANT: When the task involves creating a page AND setting up its properties/views, put ALL of that into a SINGLE task — do not split "create page" and "add properties" into separate tasks. One agent handles the full page setup atomically.
- If a later task genuinely needs a resource created by an earlier task (e.g. updating a page created in task 0), reference it as "look up page_id from shared context using key '<title>_page_id'" and set depends_on to that task's index.`;

/**
 * The planner's output contract, bound at the decoder rather than pleaded for in
 * prose (#33). The model emits its task graph by *calling* this tool, so the
 * shape is enforced by constrained decoding — a stray preamble or code fence
 * can't collapse the whole plan to `[]`.
 */
const SUBMIT_PLAN_TOOL: ToolDef = {
  name: "submit_plan",
  description:
    "Submit the decomposed task graph. Call this exactly once with the full list of subtasks.",
  input_schema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "Ordered list of subtasks (1–5).",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            task_type: { type: "string", enum: ["llm", "orchestrate"] },
            depends_on: {
              type: "array",
              items: { type: "integer" },
              description: "Zero-based indices of tasks in this list that must finish first.",
            },
            required_capabilities: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["description", "task_type", "depends_on", "required_capabilities"],
        },
      },
    },
    required: ["tasks"],
  },
};

/** Validate + repair one candidate spec; returns null if it can't be salvaged. */
function coerceTaskSpec(raw: unknown, index: number, total: number): TaskSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const description = typeof r.description === "string" ? r.description.trim() : "";
  if (!description) return null;
  const task_type = r.task_type === "orchestrate" ? "orchestrate" : "llm";
  const depends_on = Array.isArray(r.depends_on)
    ? r.depends_on
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < total && n !== index)
    : [];
  const required_capabilities = Array.isArray(r.required_capabilities)
    ? r.required_capabilities.filter((c): c is string => typeof c === "string")
    : [];
  // Default the capability to match the task type if the planner omitted it.
  if (required_capabilities.length === 0) {
    required_capabilities.push(task_type === "orchestrate" ? "orchestrate" : "llm");
  }
  return { description, task_type, depends_on, required_capabilities };
}

export function validateTaskSpecs(arr: unknown): TaskSpec[] {
  if (!Array.isArray(arr)) return [];
  const out: TaskSpec[] = [];
  for (let i = 0; i < arr.length; i++) {
    const spec = coerceTaskSpec(arr[i], i, arr.length);
    if (spec) out.push(spec);
  }
  return out;
}

/**
 * Decompose a user prompt into an ordered Pear-specific task graph.
 *
 * The planner emits its graph by calling the `submit_plan` tool (#33), so a
 * malformed free-text response no longer silently degrades a multi-step plan
 * into a single mega-task. We still accept a raw JSON array as a back-compat
 * fallback (older/weaker models that answer in text). Returns `[]` only when no
 * usable plan could be extracted — logged loudly so the degradation is visible;
 * the caller then creates one explicit fallback task.
 */
export async function planTasks(
  prompt: string,
  pageContext = "",
  overrides?: { provider: InferenceProvider; model: string },
): Promise<TaskSpec[]> {
  const inf = overrides?.provider ?? defaults().provider;
  const model = overrides?.model ?? defaults().plannerModel;

  const userMessage = pageContext
    ? `${prompt}\n\n---\n${pageContext}`
    : prompt;

  const response = await inf.chat({
    model,
    maxTokens: 1024,
    system: PLANNER_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    tools: [SUBMIT_PLAN_TOOL],
  });

  // Preferred path: the model called submit_plan, so the shape is structurally
  // guaranteed — just validate/repair the elements.
  const planCall = response.content.find(
    (b): b is ToolUseBlock => b.type === "tool_use" && b.name === "submit_plan",
  );
  if (planCall) {
    const tasks = validateTaskSpecs((planCall.input as { tasks?: unknown }).tasks);
    if (tasks.length > 0) return tasks;
    console.warn("[worker] planTasks: submit_plan returned no valid tasks");
  }

  // Fallback: a model that replied in text instead of calling the tool.
  const textBlock = response.content.find((b) => b.type === "text");
  if (textBlock?.type === "text") {
    try {
      const rawJson = textBlock.text.replace(/```(?:json)?/gi, "").trim();
      const tasks = validateTaskSpecs(JSON.parse(rawJson));
      if (tasks.length > 0) return tasks;
    } catch (err) {
      console.warn("[worker] planTasks: failed to parse fallback task graph:", err);
      console.warn("[worker] raw planner output:", textBlock.text.slice(0, 300));
    }
  }

  console.warn(
    "[worker] planTasks: no usable plan — falling back to a single task (decomposition lost)",
  );
  return [];
}
