import {
  type InferenceProvider,
  type Message,
  type ToolUseBlock,
  type ToolDef,
  getDefaultProvider,
} from "./providers.js";
import { getPearTools, executeTool, type ConnLike } from "./tools.js";

const { provider: defaultProvider, model: MODEL, plannerModel: PLANNER_MODEL, maxTokens: MAX_TOKENS } = getDefaultProvider();

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

const SYSTEM_PROMPT = `${PEAR_CONTEXT}

You have tools to directly create and modify pages in Pear. ALWAYS use tools to make changes — never just describe what the user should do manually.

Tool-use rules:
- When asked to create a database with columns: call \`create_page\` (type=Database) first — this also creates the schema. The result includes a \`schema_id\` and a \`next_step\` hint. You MUST then call \`add_property\` for EVERY specified column before writing your final summary. Never stop after just \`create_page\`.
- To add rows to a database: call \`list_properties\` (to get property_definition_ids), then \`create_row\` for each row (returns page_id), then \`set_property_value\` for each column value on that row. Repeat for every row.
- To write content into a Doc page: call \`update_page_content\` with a JSON array of BlockNote paragraph blocks.
- When a task says "look up page_id from shared context": call \`get_context\` with the relevant key before doing anything else.
- When creating a page, use the current page's ID (from the "Current page" context) as parent_id to nest it there. Use 0 only if you want it at the workspace root.
- After creating any page that a sibling task will need, the page_id is automatically stored in shared context under the page title (lowercase, spaces replaced with underscores, e.g. "Task Tracker" → "task_tracker_page_id").
- Complete ALL steps the task specifies before returning your final text summary.
- Be concise in your final summary — just confirm what was done and any relevant IDs.`;

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
export async function callLlm(
  taskDescription: string,
  conn: ConnLike,
  jobId: bigint,
  extraContext = "",
  overrides?: { provider: InferenceProvider; model: string; maxTokens?: number },
): Promise<string> {
  const inf = overrides?.provider ?? defaultProvider;
  const model = overrides?.model ?? MODEL;
  const maxTokens = overrides?.maxTokens ?? MAX_TOKENS;

  const userMessage = extraContext
    ? `${taskDescription}\n\n---\n${extraContext}`
    : taskDescription;

  const messages: Message[] = [
    { role: "user", content: userMessage },
  ];

  const tools: ToolDef[] = getPearTools(conn, jobId) as ToolDef[];

  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (iterations++ < MAX_ITERATIONS) {
    const response = await inf.chat({
      model,
      maxTokens,
      system: SYSTEM_PROMPT,
      messages,
      tools,
    });

    const toolCalls = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use"
    );

    console.log(`[worker] LLM response — stop_reason=${response.stopReason} tool_calls=${toolCalls.length} content_blocks=${response.content.map((b) => b.type).join(",")}`);

    if (toolCalls.length === 0 || response.stopReason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock?.type === "text" ? textBlock.text : "Done.";
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: { type: "tool_result"; tool_use_id: string; content: string }[] = [];
    for (const block of toolCalls) {
      console.log(`[worker] Tool call [${block.name}]: ${JSON.stringify(block.input)}`);
      const result = await executeTool(conn, block.name, block.input, jobId);
      console.log(`[worker] Tool result [${block.name}]: ${result}`);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return "Reached maximum tool iterations.";
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

Given a user request (and optional page context), decompose it into a small list of atomic, actionable subtasks that make sense inside Pear. Return ONLY a valid JSON array — no markdown, no explanation.

Each element must be:
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
 * Decompose a user prompt into an ordered Pear-specific task graph.
 * Falls back to an empty array on parse failure — caller creates one fallback task.
 */
export async function planTasks(
  prompt: string,
  pageContext = "",
  overrides?: { provider: InferenceProvider; model: string },
): Promise<TaskSpec[]> {
  const inf = overrides?.provider ?? defaultProvider;
  const model = overrides?.model ?? PLANNER_MODEL;

  const userMessage = pageContext
    ? `${prompt}\n\n---\n${pageContext}`
    : prompt;

  const response = await inf.chat({
    model,
    maxTokens: 1024,
    system: PLANNER_SYSTEM,
    messages: [{ role: "user", content: userMessage }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return [];

  try {
    const raw = textBlock.text.replace(/```(?:json)?/gi, "").trim();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as TaskSpec[];
  } catch (err) {
    console.warn("[worker] planTasks: failed to parse task graph:", err);
    console.warn("[worker] raw planner output:", textBlock.text.slice(0, 300));
    return [];
  }
}
