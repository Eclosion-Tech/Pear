/**
 * Bridge-backed inference transport: routes an AI user's completion calls
 * through `enqueue_bridge_inference` to a paired device's local providers
 * (claude -p / codex exec / ollama) instead of a cloud API key.
 *
 * Selected per AI user via `ai_user_config.inference_backend_json`
 * (`{"mode":"bridge","device_id":1,"provider":"claude-code","model":"…"}`) in
 * `getProviderForAiUser`. The substrate still enforces the per-device
 * `BridgeDeviceGrant` at the enqueue reducer — binding an AI user to a device
 * it was never granted fails per-turn with a clear error.
 *
 * Tool use (v2, ticket 14557): **ollama bindings get full Pear tool use.**
 * The worker stays the orchestrator — this provider sends structured chat
 * (`chat.messages` + `chat.tools`, ollama `/api/chat` wire shapes) through the
 * bridge, and maps returned `tool_calls` to tool_use blocks so conversation.ts
 * executes tools cloud-side exactly as with a cloud provider. claude-code /
 * codex bindings remain chat-only (flattened transcript) — those CLIs are
 * agents, not completion endpoints; their tool story is harness sessions
 * (ticket 14443).
 *
 * Still true by design:
 * * **No streaming.** `chatStream` is deliberately absent; conversation.ts
 *   falls back to the non-streaming path.
 * * **No silent fallback.** Device offline / provider failure → the turn
 *   errors with the reason. Falling back to a cloud key behind the user's
 *   back would defeat the point of the binding (see ticket 14551).
 * * **Fail loud on skew.** A structured-chat payload against a pre-v2 daemon
 *   fails payload parsing device-side → honest error, never a silently
 *   flattened run that breaks the tool loop mid-turn.
 */

// Types-only import: providers.ts imports this module at runtime, so a
// runtime import back would create an ESM cycle.
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamRequest,
  InferenceProvider,
  Message,
  StreamEvent,
  SystemPrompt,
} from "./providers.js";
import { getBridgeSql } from "./bridge-sql.js";
import { createHash } from "node:crypto";

/**
 * Parsed `inference_backend_json`. `mode: "bridge"` routes completions through
 * one-shot device inference; `mode: "harness"` routes whole turns through a
 * resumable device-side agent session (Claude Code v1 — ticket 14443).
 */
export interface BridgeBackendBinding {
  mode: "bridge" | "harness";
  device_id: number;
  provider: string;
  model?: string;
  /** harness: working directory on the device (jail-checked daemon-side). */
  cwd?: string;
  /** harness: Claude Code permission mode ("default" | "acceptEdits" | "plan"). */
  permission_mode?: string;
  /** harness: optional Claude Code --allowedTools list. */
  allowed_tools?: string[];
  /** bridge+ollama: context window override (VRAM-bound per device). */
  num_ctx?: number;
  /** bridge+ollama: explicit thinking control for thinking-capable models. */
  think?: boolean;
}

/** Parse + validate a binding; undefined for null/cloud-api/garbage. */
export function parseBridgeBackendBinding(raw: string | undefined): BridgeBackendBinding | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<BridgeBackendBinding> & { mode?: string };
    if (v.mode !== "bridge" && v.mode !== "harness") return undefined;
    if (typeof v.device_id !== "number" || typeof v.provider !== "string" || !v.provider.trim()) {
      return undefined;
    }
    return {
      mode: v.mode,
      device_id: v.device_id,
      provider: v.provider.trim(),
      model: typeof v.model === "string" && v.model.trim() ? v.model.trim() : undefined,
      cwd: typeof v.cwd === "string" && v.cwd.trim() ? v.cwd.trim() : undefined,
      permission_mode:
        typeof v.permission_mode === "string" && v.permission_mode.trim()
          ? v.permission_mode.trim()
          : undefined,
      allowed_tools: Array.isArray(v.allowed_tools)
        ? v.allowed_tools.filter((t): t is string => typeof t === "string" && !!t.trim())
        : undefined,
      num_ctx:
        typeof v.num_ctx === "number" && Number.isFinite(v.num_ctx) && v.num_ctx > 0
          ? Math.floor(v.num_ctx)
          : undefined,
      think: typeof v.think === "boolean" ? v.think : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Ollama-style chat message (worker↔ollama contract; opaque to the daemon). */
export interface OllamaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

/**
 * Translate the normalized request into ollama `/api/chat` messages. Walks in
 * order, keeping a tool_use id → name map so tool results (which reference the
 * id) can carry ollama's `tool_name`. Images degrade to a bracketed note.
 */
export function toOllamaMessages(system: string, messages: Message[]): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolCalls = m.content
        .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => {
          toolNameById.set(b.id, b.name);
          return { function: { name: b.name, arguments: b.input } };
        });
      out.push({
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (typeof m.content === "string") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    const blocks = m.content;
    const toolResults = blocks.filter(
      (b): b is Extract<(typeof blocks)[number], { type: "tool_result" }> =>
        b.type === "tool_result",
    );
    if (toolResults.length > 0) {
      for (const r of toolResults) {
        out.push({
          role: "tool",
          content: r.content,
          ...(toolNameById.has(r.tool_use_id)
            ? { tool_name: toolNameById.get(r.tool_use_id) }
            : {}),
        });
      }
      continue;
    }
    const text = blocks
      .map((b) =>
        b.type === "text" ? b.text : "[image attachment — not forwarded over the bridge]",
      )
      .join("\n");
    out.push({ role: "user", content: text });
  }
  return out;
}

/** Parse a tool call's arguments defensively (some models double-encode). */
function toolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return {};
}

/** Render the chat transcript as a single prompt for one-shot inference. */
export function renderTranscript(messages: Message[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        parts.push(`Human: ${m.content}`);
        continue;
      }
      const rendered = m.content
        .map((b) => {
          if (b.type === "text") return b.text;
          if (b.type === "tool_result") return `[tool result]\n${b.content}`;
          return "[image attachment — not forwarded over the bridge]";
        })
        .join("\n");
      parts.push(`Human: ${rendered}`);
    } else {
      const rendered = m.content
        .map((b) => (b.type === "text" ? b.text : `[tool call: ${b.name}]`))
        .join("\n");
      parts.push(`Assistant: ${rendered}`);
    }
  }
  parts.push("Assistant:");
  return parts.join("\n\n");
}

interface ConnForBridge {
  db: Record<string, unknown>;
  reducers: {
    enqueueBridgeInference(args: {
      deviceId: bigint;
      provider: string;
      model: string;
      payloadJson: string;
      conversationId: bigint;
      jobId: undefined;
      taskId: undefined;
      nonce: string;
    }): Promise<void> | void;
  };
}

const WAIT_TIMEOUT_MS = 300_000;
const DEVICE_BUDGET_SECONDS = 240;
const ENQUEUE_VISIBLE_MS = 10_000;
// How long a row may sit Pending before we call the device unresponsive. The
// transports ack pickup (Pending → Running via mark_bridge_command_running),
// so this normally trips within one poll cycle of a truly dead device — but
// it must still tolerate a version-skew window where no ack ever comes (older
// relay/module) plus slow local-model pickup, hence 30s rather than 10s. The
// real backstop is WAIT_TIMEOUT_MS.
const PENDING_GRACE_MS = 30_000;

export class BridgeInferenceProvider implements InferenceProvider {
  /**
   * Present ONLY for ollama bridge bindings: streamed turns via
   * bridge_command_chunk rows (chunked, ~2-3 flushes/sec — see the daemon's
   * run_ollama_stream). Left undefined otherwise so conversation.ts falls back
   * to the non-streaming chat() path (claude/codex bindings, harness mode).
   */
  chatStream?: (request: ChatStreamRequest) => AsyncIterable<StreamEvent>;

  constructor(
    protected readonly conn: ConnForBridge,
    protected readonly aiIdentityHex: string,
    protected readonly binding: BridgeBackendBinding,
  ) {
    if (binding.mode === "bridge" && binding.provider === "ollama") {
      this.chatStream = (request) => this.streamTurn(request);
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const deviceId = BigInt(this.binding.device_id);
    const model = this.binding.model ?? request.model;

    // Connected pre-flight — fail the turn immediately when the device is
    // down, with a message the user can act on (never silently fall back).
    type DeviceSummary = { id: bigint; name: string; connected: boolean; revokedAt?: unknown };
    const summaryIter =
      (this.conn.db as { bridge_device_summary?: { iter: () => Iterable<DeviceSummary> } })
        .bridge_device_summary?.iter?.() ??
      (this.conn.db as { bridgeDeviceSummary?: { iter: () => Iterable<DeviceSummary> } })
        .bridgeDeviceSummary?.iter?.();
    if (summaryIter) {
      const dev = [...summaryIter].find((d) => String(d.id) === String(deviceId));
      if (!dev || dev.revokedAt != null) {
        throw new Error(
          `This AI user's inference backend is bridge device ${deviceId}, which is not paired/available. ` +
            `Fix the binding or clear it to use a cloud API key.`,
        );
      }
      if (!dev.connected) {
        throw new Error(
          `This AI user runs inference on bridge device ${deviceId} (${dev.name}), which is offline. ` +
            `Start pear-bridge on that machine, or clear the binding to use a cloud API key.`,
        );
      }
    }

    const nonce = await this.enqueueTurn(request, deviceId, model, false);

    const row = await this.awaitCommandRow(deviceId, nonce);
    const result = await this.awaitResult(deviceId, row.id);

    if (result.rejectionReason) {
      throw new Error(`Bridge inference was rejected: ${result.rejectionReason}`);
    }
    return this.parseResultEnvelope(result, deviceId, { includeThinking: true });
  }

  /** Connected/paired precheck — throws with an actionable message. */
  protected async precheckDevice(deviceId: bigint): Promise<void> {
    type DeviceSummary = { id: bigint; name: string; connected: boolean; revokedAt?: unknown };
    const summaryIter =
      (this.conn.db as { bridge_device_summary?: { iter: () => Iterable<DeviceSummary> } })
        .bridge_device_summary?.iter?.() ??
      (this.conn.db as { bridgeDeviceSummary?: { iter: () => Iterable<DeviceSummary> } })
        .bridgeDeviceSummary?.iter?.();
    if (!summaryIter) return;
    const dev = [...summaryIter].find((d) => String(d.id) === String(deviceId));
    if (!dev || dev.revokedAt != null) {
      throw new Error(
        `This AI user's inference backend is bridge device ${deviceId}, which is not paired/available. ` +
          `Fix the binding or clear it to use a cloud API key.`,
      );
    }
    if (!dev.connected) {
      throw new Error(
        `This AI user runs inference on bridge device ${deviceId} (${dev.name}), which is offline. ` +
          `Start pear-bridge on that machine, or clear the binding to use a cloud API key.`,
      );
    }
  }

  /** Build + enqueue the inference payload; returns the correlation nonce. */
  protected async enqueueTurn(
    request: ChatRequest,
    deviceId: bigint,
    model: string | undefined,
    stream: boolean,
  ): Promise<string> {
    // Ollama bindings speak structured chat (tool calling); claude/codex stay
    // on the flattened transcript (chat-only until harness sessions, 14443).
    const structured = this.binding.provider === "ollama";
    const body = structured
      ? {
          provider: this.binding.provider,
          ...(model ? { model } : {}),
          chat: {
            messages: toOllamaMessages(systemText(request.system), request.messages),
            ...(request.tools && request.tools.length > 0
              ? {
                  tools: request.tools.map((t) => ({
                    type: "function",
                    function: {
                      name: t.name,
                      description: t.description,
                      parameters: t.input_schema,
                    },
                  })),
                }
              : {}),
          },
          timeout_seconds: DEVICE_BUDGET_SECONDS,
          ...(this.binding.num_ctx ? { num_ctx: this.binding.num_ctx } : {}),
          ...(this.binding.think !== undefined ? { think: this.binding.think } : {}),
          ...(stream ? { stream: true } : {}),
        }
      : {
          provider: this.binding.provider,
          ...(model ? { model } : {}),
          prompt: renderTranscript(request.messages),
          ...(systemText(request.system) ? { system: systemText(request.system) } : {}),
          timeout_seconds: DEVICE_BUDGET_SECONDS,
          ...(this.binding.num_ctx ? { num_ctx: this.binding.num_ctx } : {}),
          ...(this.binding.think !== undefined ? { think: this.binding.think } : {}),
        };

    const nonce = globalThis.crypto.randomUUID();
    await this.conn.reducers.enqueueBridgeInference({
      deviceId,
      provider: this.binding.provider,
      model: model ?? "",
      payloadJson: JSON.stringify(body),
      conversationId: request.conversationId ?? BigInt(0),
      jobId: undefined,
      taskId: undefined,
      nonce,
    });
    return nonce;
  }

  /** Map a result row's InferenceResult envelope onto a ChatResponse. */
  protected parseResultEnvelope(
    result: { stdout: string; rejectionReason?: string | null },
    deviceId: bigint,
    opts: { includeThinking: boolean },
  ): ChatResponse {
    let envelope:
      | {
          ok?: boolean;
          output?: string;
          error?: string;
          thinking?: string;
          usage?: { input_tokens?: number; output_tokens?: number };
          tool_calls?: Array<{ name?: string; arguments?: unknown }>;
        }
      | undefined;
    try {
      envelope = JSON.parse(result.stdout) as typeof envelope;
    } catch {
      envelope = undefined;
    }
    if (!envelope || typeof envelope.ok !== "boolean") {
      throw new Error(
        "Bridge device returned an unreadable inference envelope (older pear-bridge build?)",
      );
    }
    if (!envelope.ok) {
      throw new Error(
        `Bridge inference failed on device ${deviceId} (${this.binding.provider}): ${envelope.error ?? "no detail"}`,
      );
    }

    const content: ChatResponse["content"] = [];
    if (envelope.output) content.push({ type: "text", text: envelope.output });
    const toolCalls = (envelope.tool_calls ?? []).filter(
      (c): c is { name: string; arguments?: unknown } => typeof c.name === "string" && !!c.name,
    );
    for (const call of toolCalls) {
      content.push({
        type: "tool_use",
        // Ollama doesn't mint call ids — generate them; toOllamaMessages maps
        // them back to names when the tool results return next iteration.
        id: `bridge_${globalThis.crypto.randomUUID()}`,
        name: call.name,
        input: toolArguments(call.arguments),
      });
    }
    if (content.length === 0) content.push({ type: "text", text: "" });
    return {
      content,
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      // Streaming turns already delivered thinking as deltas — including it
      // again on done would double-count.
      ...(opts.includeThinking && envelope.thinking ? { thinking: envelope.thinking } : {}),
      // Real device-side token counts → turnUsage/update_message, so bridge
      // turns stop reading 0/0 in the usage telemetry.
      ...(typeof envelope.usage?.input_tokens === "number" &&
      typeof envelope.usage?.output_tokens === "number"
        ? {
            usage: {
              inputTokens: envelope.usage.input_tokens,
              outputTokens: envelope.usage.output_tokens,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
            },
          }
        : {}),
    };
  }

  /**
   * Streamed turn: enqueue with `stream:true`, forward chunk deltas as they
   * land in bridge_command_chunk, and finish with the full result envelope.
   */
  private async *streamTurn(request: ChatStreamRequest): AsyncIterable<StreamEvent> {
    const deviceId = BigInt(this.binding.device_id);
    await this.precheckDevice(deviceId);
    const model = this.binding.model ?? request.model;
    const nonce = await this.enqueueTurn(request, deviceId, model, true);
    const row = await this.awaitCommandRow(deviceId, nonce);

    const sql = getBridgeSql(this.aiIdentityHex);
    const readChunks = sql?.chunksForCommand?.bind(sql);
    let lastSeq = -1;
    const start = Date.now();
    let everLeftPending = false;
    while (Date.now() - start < WAIT_TIMEOUT_MS) {
      if (readChunks) {
        for (const chunk of await readChunks(row.id)) {
          if (chunk.seq <= lastSeq) continue;
          lastSeq = chunk.seq;
          try {
            const delta = JSON.parse(chunk.content) as { t?: string; d?: string };
            if (delta.d) {
              yield delta.t === "think"
                ? { type: "thinking_delta", text: delta.d }
                : { type: "text_delta", text: delta.d };
            }
          } catch {
            /* malformed chunk — skip */
          }
        }
      }
      const result = await this.readResult(row.id);
      if (result) {
        if (result.rejectionReason) {
          throw new Error(`Bridge inference was rejected: ${result.rejectionReason}`);
        }
        const response = this.parseResultEnvelope(result, deviceId, { includeThinking: false });
        for (const block of response.content) {
          if (block.type === "tool_use") yield { type: "tool_use_start", block };
        }
        yield { type: "done", response };
        return;
      }
      const cmdRow = (await this.readCommands(deviceId)).find(
        (r) => String(r.id) === String(row.id),
      );
      const tag = cmdRow?.status?.tag;
      if (tag && tag !== "Pending") everLeftPending = true;
      if (tag === "Pending" && !everLeftPending && Date.now() - start > PENDING_GRACE_MS) {
        throw new Error(
          `Bridge device ${deviceId} did not pick up the inference request — it is likely ` +
            `offline or running an older pear-bridge without inference support.`,
        );
      }
      await sleep(300);
    }
    throw new Error(
      `Bridge inference on device ${deviceId} produced no result within ${WAIT_TIMEOUT_MS / 1000}s.`,
    );
  }

  protected async awaitCommandRow(
    deviceId: bigint,
    nonce: string,
  ): Promise<{ id: bigint | string; status?: { tag: string } }> {
    const start = Date.now();
    while (Date.now() - start < ENQUEUE_VISIBLE_MS) {
      const rows = await this.readCommands(deviceId);
      const row = rows.find((r) => r.nonce === nonce);
      if (row) return row;
      await sleep(100);
    }
    throw new Error(
      `Bridge inference was enqueued for device ${deviceId} but never became visible — ` +
        `the device may have no connected session.`,
    );
  }

  protected async awaitResult(
    deviceId: bigint,
    commandId: bigint | string,
  ): Promise<{ stdout: string; rejectionReason?: string | null }> {
    const start = Date.now();
    let lastTag: string | undefined;
    let everLeftPending = false;
    while (Date.now() - start < WAIT_TIMEOUT_MS) {
      const result = await this.readResult(commandId);
      if (result) return result;
      const row = (await this.readCommands(deviceId)).find(
        (r) => String(r.id) === String(commandId),
      );
      lastTag = row?.status?.tag;
      if (lastTag && lastTag !== "Pending") everLeftPending = true;
      if (lastTag === "Pending" && !everLeftPending && Date.now() - start > PENDING_GRACE_MS) {
        throw new Error(
          `Bridge device ${deviceId} did not pick up the inference request — it is likely ` +
            `offline or running an older pear-bridge without inference support.`,
        );
      }
      await sleep(150);
    }
    throw new Error(
      `Bridge inference on device ${deviceId} produced no result within ${WAIT_TIMEOUT_MS / 1000}s.`,
    );
  }

  protected async readCommands(deviceId: bigint): Promise<
    Array<{ id: bigint | string; status?: { tag: string }; nonce?: string | null }>
  > {
    const sql = getBridgeSql(this.aiIdentityHex);
    if (sql) return sql.commandsForDevice(deviceId);
    const iter =
      (this.conn.db as { bridge_command?: { iter: () => Iterable<never> } }).bridge_command?.iter?.() ??
      (this.conn.db as { bridgeCommand?: { iter: () => Iterable<never> } }).bridgeCommand?.iter?.();
    return iter ? [...iter] : [];
  }

  protected async readResult(
    commandId: bigint | string,
  ): Promise<{ stdout: string; rejectionReason?: string | null } | undefined> {
    const sql = getBridgeSql(this.aiIdentityHex);
    if (sql) return sql.resultForCommand(commandId);
    type Res = { commandId: bigint; stdout: string; rejectionReason?: string };
    const iter =
      (this.conn.db as { bridge_command_result?: { iter: () => Iterable<Res> } })
        .bridge_command_result?.iter?.() ??
      (this.conn.db as { bridgeCommandResult?: { iter: () => Iterable<Res> } })
        .bridgeCommandResult?.iter?.();
    return iter ? [...iter].find((r) => String(r.commandId) === String(commandId)) : undefined;
  }
}

function systemText(system: SystemPrompt): string {
  const flat = typeof system === "string" ? system : system.map((b) => b.text).join("\n\n");
  return flat.trim();
}

/**
 * Deterministic per-(AI user, conversation) session UUID: sha256 of a stable
 * key, formatted as a v4-shaped UUID (Claude Code requires a valid UUID for
 * `--session-id`). Deterministic ⇒ no storage: every turn of the same
 * conversation derives the same id, and the daemon resumes it.
 */
export function harnessSessionId(aiIdentityHex: string, conversationId: bigint): string {
  const digest = createHash("sha256")
    .update(`pear-harness:${aiIdentityHex.replace(/^0x/i, "").toLowerCase()}:${conversationId}`)
    .digest("hex");
  const h = digest.slice(0, 32).split("");
  h[12] = "4"; // version nibble
  h[16] = "8"; // variant nibble (10xx)
  const s = h.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** The latest human message text — the harness holds prior context itself. */
export function latestUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const text = m.content
      .map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "tool_result") return "";
        return "[image attachment — not forwarded over the bridge]";
      })
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return "";
}

/**
 * Harness runtime (`mode: "harness"`, ticket 14443): whole turns run as a
 * resumable Claude Code session on the device, bound per conversation.
 *
 * The division of labor inverts v1 inference: the DEVICE holds the loop and
 * the context (Claude Code session state), so this provider sends only the
 * latest user message. Claude's LOCAL tools (bash/edit/read in the bound
 * working tree, under its own permission mode) are live — that is the point.
 * Pear tools are NOT offered through the harness yet; the MCP loop-back (the
 * harness connecting to Pear as the same AI user) is the next 14443 phase,
 * alongside transcript streaming and the approvals flow.
 */
export class BridgeHarnessProvider extends BridgeInferenceProvider implements InferenceProvider {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const deviceId = BigInt(this.binding.device_id);
    await this.precheckDevice(deviceId);

    const prompt = latestUserMessage(request.messages);
    if (!prompt.trim()) {
      throw new Error("Harness turn has no user message to forward.");
    }
    const sessionId = harnessSessionId(this.aiIdentityHex, request.conversationId ?? BigInt(0));

    const nonce = globalThis.crypto.randomUUID();
    await (this.conn.reducers as unknown as {
      enqueueBridgeHarness(args: {
        deviceId: bigint;
        provider: string;
        payloadJson: string;
        conversationId: bigint;
        jobId: undefined;
        taskId: undefined;
        nonce: string;
      }): Promise<void> | void;
    }).enqueueBridgeHarness({
      deviceId,
      provider: this.binding.provider,
      payloadJson: JSON.stringify({
        provider: this.binding.provider,
        session_id: sessionId,
        prompt,
        ...(this.binding.cwd ? { cwd: this.binding.cwd } : {}),
        ...(this.binding.permission_mode
          ? { permission_mode: this.binding.permission_mode }
          : {}),
        ...(this.binding.allowed_tools && this.binding.allowed_tools.length > 0
          ? { allowed_tools: this.binding.allowed_tools }
          : {}),
        timeout_seconds: 600,
      }),
      conversationId: request.conversationId ?? BigInt(0),
      jobId: undefined,
      taskId: undefined,
      nonce,
    });

    const row = await this.awaitCommandRow(deviceId, nonce);
    const result = await this.awaitHarnessResult(deviceId, row.id);

    if (result.rejectionReason) {
      throw new Error(`Bridge harness turn was rejected: ${result.rejectionReason}`);
    }
    let envelope:
      | { ok?: boolean; output?: string; error?: string; resumed?: boolean; session_id?: string }
      | undefined;
    try {
      envelope = JSON.parse(result.stdout) as typeof envelope;
    } catch {
      envelope = undefined;
    }
    if (!envelope || typeof envelope.ok !== "boolean") {
      throw new Error(
        "Bridge device returned an unreadable harness envelope (older pear-bridge build?)",
      );
    }
    if (!envelope.ok) {
      throw new Error(
        `Harness turn failed on device ${deviceId} (${this.binding.provider}): ${envelope.error ?? "no detail"}`,
      );
    }

    // A non-first turn that could NOT resume means device-side context was
    // reset (pruned state, different machine) — surface that honestly instead
    // of letting the model silently answer without its history.
    const hadHistory = request.messages.length > 1;
    const resetNote =
      hadHistory && envelope.resumed === false
        ? "[note: the device-side session could not be resumed — earlier conversation context may not have carried over]\n\n"
        : "";
    return {
      content: [{ type: "text", text: `${resetNote}${envelope.output ?? ""}` }],
      stopReason: "end_turn",
    };
  }

  /** Device connectivity precheck shared with the inference path. */
  protected async precheckDevice(deviceId: bigint): Promise<void> {
    type DeviceSummary = { id: bigint; name: string; connected: boolean; revokedAt?: unknown };
    const summaryIter =
      (this.conn.db as { bridge_device_summary?: { iter: () => Iterable<DeviceSummary> } })
        .bridge_device_summary?.iter?.() ??
      (this.conn.db as { bridgeDeviceSummary?: { iter: () => Iterable<DeviceSummary> } })
        .bridgeDeviceSummary?.iter?.();
    if (!summaryIter) return;
    const dev = [...summaryIter].find((d) => String(d.id) === String(deviceId));
    if (!dev || dev.revokedAt != null) {
      throw new Error(
        `This AI user's harness runs on bridge device ${deviceId}, which is not paired/available. ` +
          `Fix the binding or clear it to use a cloud API key.`,
      );
    }
    if (!dev.connected) {
      throw new Error(
        `This AI user's harness runs on bridge device ${deviceId} (${dev.name}), which is offline. ` +
          `Start pear-bridge on that machine, or clear the binding to use a cloud API key.`,
      );
    }
  }

  /** Harness turns can be long — wider wait than the inference default. */
  private async awaitHarnessResult(
    deviceId: bigint,
    commandId: bigint | string,
  ): Promise<{ stdout: string; rejectionReason?: string | null }> {
    const HARNESS_WAIT_MS = 660_000; // device budget 600s + margin
    const start = Date.now();
    let everLeftPending = false;
    while (Date.now() - start < HARNESS_WAIT_MS) {
      const result = await this.readResult(commandId);
      if (result) return result;
      const row = (await this.readCommands(deviceId)).find(
        (r) => String(r.id) === String(commandId),
      );
      const tag = row?.status?.tag;
      if (tag && tag !== "Pending") everLeftPending = true;
      if (tag === "Pending" && !everLeftPending && Date.now() - start > PENDING_GRACE_MS) {
        throw new Error(
          `Bridge device ${deviceId} did not pick up the harness turn — it is likely offline ` +
            `or running an older pear-bridge without harness support.`,
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(
      `Harness turn on device ${deviceId} produced no result within ${HARNESS_WAIT_MS / 1000}s.`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
