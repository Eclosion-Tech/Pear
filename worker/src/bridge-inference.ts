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
  InferenceProvider,
  Message,
  SystemPrompt,
} from "./providers.js";
import { getBridgeSql } from "./bridge-sql.js";

/** Parsed `inference_backend_json`. */
export interface BridgeBackendBinding {
  mode: "bridge";
  device_id: number;
  provider: string;
  model?: string;
}

/** Parse + validate a binding; undefined for null/cloud-api/garbage. */
export function parseBridgeBackendBinding(raw: string | undefined): BridgeBackendBinding | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<BridgeBackendBinding> & { mode?: string };
    if (v.mode !== "bridge") return undefined;
    if (typeof v.device_id !== "number" || typeof v.provider !== "string" || !v.provider.trim()) {
      return undefined;
    }
    return {
      mode: "bridge",
      device_id: v.device_id,
      provider: v.provider.trim(),
      model: typeof v.model === "string" && v.model.trim() ? v.model.trim() : undefined,
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
const PENDING_GRACE_MS = 10_000;

export class BridgeInferenceProvider implements InferenceProvider {
  constructor(
    private readonly conn: ConnForBridge,
    private readonly aiIdentityHex: string,
    private readonly binding: BridgeBackendBinding,
  ) {}

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
        }
      : {
          provider: this.binding.provider,
          ...(model ? { model } : {}),
          prompt: renderTranscript(request.messages),
          ...(systemText(request.system) ? { system: systemText(request.system) } : {}),
          timeout_seconds: DEVICE_BUDGET_SECONDS,
        };

    const nonce = globalThis.crypto.randomUUID();
    await this.conn.reducers.enqueueBridgeInference({
      deviceId,
      provider: this.binding.provider,
      model: model ?? "",
      payloadJson: JSON.stringify(body),
      conversationId: BigInt(0),
      jobId: undefined,
      taskId: undefined,
      nonce,
    });

    const row = await this.awaitCommandRow(deviceId, nonce);
    const result = await this.awaitResult(deviceId, row.id);

    if (result.rejectionReason) {
      throw new Error(`Bridge inference was rejected: ${result.rejectionReason}`);
    }
    let envelope:
      | {
          ok?: boolean;
          output?: string;
          error?: string;
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
    };
  }

  private async awaitCommandRow(
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

  private async awaitResult(
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

  private async readCommands(deviceId: bigint): Promise<
    Array<{ id: bigint | string; status?: { tag: string }; nonce?: string | null }>
  > {
    const sql = getBridgeSql(this.aiIdentityHex);
    if (sql) return sql.commandsForDevice(deviceId);
    const iter =
      (this.conn.db as { bridge_command?: { iter: () => Iterable<never> } }).bridge_command?.iter?.() ??
      (this.conn.db as { bridgeCommand?: { iter: () => Iterable<never> } }).bridgeCommand?.iter?.();
    return iter ? [...iter] : [];
  }

  private async readResult(
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
