/**
 * Provider-agnostic inference abstraction.
 *
 * Normalized message types sit close to Anthropic's format (content blocks,
 * tool_use / tool_result). Each provider converts to/from its native API.
 *
 * Two ways to create a provider:
 *   1. `createProvider(name, endpoint?)` — reads API keys from env vars
 *      (used by the orcha planner / self-hosted single-tenant deployments)
 *   2. `createProviderFromConfig(config)` — reads from an AiUserConfig row
 *      (per-AI-user keys, what conversation handlers always use)
 *
 * Use `getProviderForAiUser(conn, aiUserId)` from inside an AI-user-scoped
 * connection. The `client_visibility_filter` on `ai_user_config` ensures
 * the connection only ever sees its own row, so this is a 1-row lookup.
 * It throws if the row doesn't exist or has no api_key — there is no
 * env-var fallback (a missing key is a configuration error, not a transient
 * issue, and falling back to env silently exfiltrates the operator's key).
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { catalogFamilyFor, effortSupportFor, type CatalogFamily } from "./model-catalog.js";
import { BridgeInferenceProvider, parseBridgeBackendBinding } from "./bridge-inference.js";

// ── Normalized types ────────────────────────────────────────────────────────────

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};
/**
 * A normalized image block. Shape matches Anthropic's native image block so the
 * Anthropic adapter can pass it through unchanged; other adapters translate it
 * (OpenAI-family → an `image_url` data URL). Provider-agnostic at this layer —
 * Pear users can configure any provider.
 */
export type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
/** User-turn content blocks (a message with attached images renders as these). */
export type UserContentBlock = TextBlock | ImageBlock;

export type UserMessage = {
  role: "user";
  // A string (plain text), tool results, or text+image blocks (attachments).
  content: string | ToolResultBlock[] | UserContentBlock[];
};
export type AssistantMessage = {
  role: "assistant";
  content: (TextBlock | ToolUseBlock)[];
};
export type Message = UserMessage | AssistantMessage;

/**
 * A system-prompt segment. `cache: true` places a prompt-cache breakpoint at the
 * end of this block (Anthropic only). Stable blocks come first so the cached
 * prefix captures them; volatile content goes in a trailing block with no
 * breakpoint. See assessment #8/#21/#22 and `SystemPromptBuilder.buildBlocks`.
 */
export type SystemBlock = { text: string; cache?: boolean };
export type SystemPrompt = string | SystemBlock[];

/** Flatten a structured system prompt to a plain string (providers without caching). */
export function flattenSystem(system: SystemPrompt): string {
  return typeof system === "string" ? system : system.map((b) => b.text).join("\n\n");
}

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export interface ChatRequest {
  model: string;
  maxTokens: number;
  system: SystemPrompt;
  messages: Message[];
  tools?: ToolDef[];
  /**
   * Reasoning effort/intensity level (e.g. "low" | "medium" | "high" | …).
   * Mapped to the provider's native knob — Anthropic `output_config.effort`,
   * OpenAI `reasoning_effort` — only when the model's catalog descriptor
   * supports it; ignored (no param sent) otherwise. Gated/validated upstream;
   * providers also re-check against the catalog before sending.
   */
  effort?: string;
}

/**
 * Real token usage for a single provider response, normalized across providers.
 * `inputTokens`/`outputTokens` are the uncached prompt + completion counts;
 * the cache fields are Anthropic-style (read = served from cache, creation =
 * written to cache). OpenAI maps `cached_tokens` to `cacheReadInputTokens` and
 * leaves creation at 0. All four feed `update_message` / `record_usage_event`
 * so the per-AI-user spend surface reflects real consumption (assessment #3).
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export interface ChatResponse {
  content: (TextBlock | ToolUseBlock)[];
  stopReason: string;
  thinking?: string;
  usage?: TokenUsage;
}

export type StreamEvent =
  | { type: "thinking_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; block: ToolUseBlock }
  | { type: "done"; response: ChatResponse };

export interface ChatStreamRequest extends ChatRequest {
  thinkingBudget?: number;
}

export interface InferenceProvider {
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream?(request: ChatStreamRequest): AsyncIterable<StreamEvent>;
}

// ── Anthropic ───────────────────────────────────────────────────────────────────

/**
 * Convert our `SystemPrompt` to the Anthropic `system` param, attaching a
 * `cache_control: {type:"ephemeral"}` breakpoint at the end of each block marked
 * `cache: true`. Anthropic allows at most 4 breakpoints per request; the builder
 * emits at most 2. A string passes through unchanged (no caching).
 */
function toAnthropicSystem(
  system: SystemPrompt,
): string | Anthropic.Messages.TextBlockParam[] {
  if (typeof system === "string") return system;
  return system.map((b) => ({
    type: "text" as const,
    text: b.text,
    ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

/** Normalize an Anthropic `usage` object to our cross-provider `TokenUsage`. */
function anthropicUsage(
  usage:
    | {
        input_tokens?: number | null;
        output_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
      }
    | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/** Normalize an OpenAI `usage` object to our cross-provider `TokenUsage`. */
function openaiUsage(
  usage:
    | {
        prompt_tokens?: number | null;
        completion_tokens?: number | null;
        prompt_tokens_details?: { cached_tokens?: number | null } | null;
      }
    | undefined,
): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

/** Log cache read/write so a silent invalidator (zero reads) is visible (#21 verification). */
function logCacheUsage(
  tag: string,
  usage: { cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; input_tokens?: number | null } | undefined,
): void {
  if (!usage) return;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  if (read || write) {
    console.log(
      `[providers] ${tag} cache: read=${read} write=${write} uncached=${usage.input_tokens ?? 0}`,
    );
  }
}

/**
 * Anthropic thinking + effort params for a request, derived from the model's
 * catalog capability:
 *  - Adaptive-thinking family (Opus 4.6+/Sonnet 4.6/Fable — `anthropic_effort`):
 *    `thinking: {type:"adaptive"}`, plus `output_config.effort` when a valid
 *    effort level is requested. Never `budget_tokens` (rejected with a 400).
 *  - Everything else (Haiku 4.5, Claude 3.7, …): legacy extended thinking via
 *    `budget_tokens` when a budget is provided.
 * Returns `{}` when no thinking is wanted, so callers can merge unconditionally.
 */
function anthropicThinkingParams(
  model: string,
  effort: string | undefined,
  thinkingBudget: number | undefined,
): Record<string, unknown> {
  const support = effortSupportFor(model);
  if (support.kind === "anthropic_effort") {
    const out: Record<string, unknown> = {};
    if (effort || thinkingBudget) out.thinking = { type: "adaptive" };
    if (effort && support.levels?.includes(effort)) {
      out.output_config = { effort };
    }
    return out;
  }
  if (thinkingBudget) {
    return { thinking: { type: "enabled", budget_tokens: thinkingBudget } };
  }
  return {};
}

class AnthropicProvider implements InferenceProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const params: Anthropic.Messages.MessageCreateParams = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: toAnthropicSystem(request.system),
      messages: request.messages as Anthropic.Messages.MessageParam[],
    };
    if (request.tools?.length) {
      params.tools = request.tools as Anthropic.Messages.Tool[];
    }
    Object.assign(params, anthropicThinkingParams(request.model, request.effort, undefined));

    const response = await this.client.messages.create(params);
    logCacheUsage("chat", response.usage);

    return {
      content: response.content.map((block) => {
        if (block.type === "tool_use") {
          return {
            type: "tool_use" as const,
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          };
        }
        return { type: "text" as const, text: (block as Anthropic.Messages.TextBlock).text };
      }),
      stopReason: response.stop_reason ?? "end_turn",
      usage: anthropicUsage(response.usage),
    };
  }

  async *chatStream(request: ChatStreamRequest): AsyncIterable<StreamEvent> {
    const params: Anthropic.Messages.MessageStreamParams = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: toAnthropicSystem(request.system),
      messages: request.messages as Anthropic.Messages.MessageParam[],
    };
    if (request.tools?.length) {
      params.tools = request.tools as Anthropic.Messages.Tool[];
    }
    Object.assign(
      params,
      anthropicThinkingParams(request.model, request.effort, request.thinkingBudget),
    );

    const stream = this.client.messages.stream(params);

    let thinkingText = "";
    const contentBlocks: (TextBlock | ToolUseBlock)[] = [];
    const pendingToolUse: Map<number, { id: string; name: string; jsonChunks: string[] }> = new Map();
    let stopReason = "end_turn";

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block.type === "tool_use") {
          pendingToolUse.set(event.index, { id: block.id, name: block.name, jsonChunks: [] });
        }
      } else if (event.type === "content_block_delta") {
        const delta = event.delta;
        if (delta.type === "thinking_delta") {
          thinkingText += delta.thinking;
          yield { type: "thinking_delta", text: delta.thinking };
        } else if (delta.type === "text_delta") {
          yield { type: "text_delta", text: delta.text };
        } else if (delta.type === "input_json_delta") {
          const pending = pendingToolUse.get(event.index);
          if (pending) pending.jsonChunks.push(delta.partial_json);
        }
      } else if (event.type === "content_block_stop") {
        const pending = pendingToolUse.get(event.index);
        if (pending) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(pending.jsonChunks.join(""));
          } catch { /* malformed args */ }
          const toolBlock: ToolUseBlock = {
            type: "tool_use",
            id: pending.id,
            name: pending.name,
            input,
          };
          contentBlocks.push(toolBlock);
          yield { type: "tool_use_start", block: toolBlock };
          pendingToolUse.delete(event.index);
        }
      } else if (event.type === "message_delta") {
        stopReason = (event as { delta: { stop_reason?: string } }).delta.stop_reason ?? stopReason;
      }
    }

    const finalMessage = await stream.finalMessage();
    logCacheUsage("stream", finalMessage.usage);
    const finalContent: (TextBlock | ToolUseBlock)[] = [];
    for (const block of finalMessage.content) {
      if (block.type === "tool_use") {
        finalContent.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      } else if (block.type === "text") {
        finalContent.push({ type: "text", text: block.text });
      }
    }

    yield {
      type: "done",
      response: {
        content: finalContent,
        stopReason: finalMessage.stop_reason ?? "end_turn",
        thinking: thinkingText || undefined,
        usage: anthropicUsage(finalMessage.usage),
      },
    };
  }
}

// ── OpenAI / OpenAI-compatible ──────────────────────────────────────────────────

/** OpenAI `finish_reason` → our Anthropic-style stop reasons. */
const OPENAI_STOP_MAP: Record<string, string> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  length: "max_tokens",
};

class OpenAIProvider implements InferenceProvider {
  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  private buildParams(
    request: ChatRequest,
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: flattenSystem(request.system) },
    ];

    for (const msg of request.messages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          messages.push({ role: "user", content: msg.content });
        } else if (msg.content.length > 0 && "tool_use_id" in msg.content[0]) {
          for (const block of msg.content as ToolResultBlock[]) {
            messages.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        } else {
          // Text + image attachment blocks → OpenAI multimodal content parts.
          const parts = (msg.content as UserContentBlock[]).map((b) =>
            b.type === "image"
              ? {
                  type: "image_url" as const,
                  image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
                }
              : { type: "text" as const, text: b.text },
          );
          messages.push({ role: "user", content: parts });
        }
      } else {
        const textParts = msg.content
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        const toolCalls = msg.content
          .filter((b): b is ToolUseBlock => b.type === "tool_use")
          .map((b) => ({
            id: b.id,
            type: "function" as const,
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));

        messages.push({
          role: "assistant",
          content: textParts || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
      }
    }

    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens,
      messages,
    };
    if (request.tools?.length) {
      params.tools = request.tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }
    const effortSupport = effortSupportFor(request.model);
    if (
      request.effort &&
      effortSupport.kind === "openai_reasoning_effort" &&
      effortSupport.levels?.includes(request.effort)
    ) {
      Object.assign(params, { reasoning_effort: request.effort });
    }
    return params;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.chat.completions.create(
      this.buildParams(request),
    );
    const choice = response.choices[0];
    if (!choice) throw new Error("No completion choice returned");

    const content: (TextBlock | ToolUseBlock)[] = [];
    if (choice.message.content) {
      content.push({ type: "text", text: choice.message.content });
    }
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        if (!("function" in tc)) continue;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch { /* malformed args — pass empty */ }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
    }

    return {
      content,
      stopReason: OPENAI_STOP_MAP[choice.finish_reason ?? "stop"] ?? "end_turn",
      usage: openaiUsage(response.usage),
    };
  }

  async *chatStream(request: ChatStreamRequest): AsyncIterable<StreamEvent> {
    // `thinkingBudget` has no chat-completions equivalent; reasoning depth is
    // steered via `reasoning_effort` in buildParams where the model supports it.
    const stream = await this.client.chat.completions.create({
      ...this.buildParams(request),
      stream: true,
      // Ask for a final usage chunk so streamed turns bill like non-streamed
      // ones. Supported by OpenAI, OpenRouter, and Ollama's compat layer.
      stream_options: { include_usage: true },
    });

    let text = "";
    let thinking = "";
    let stopReason: string | undefined;
    let usage: TokenUsage | undefined;
    const finishedTools: ToolUseBlock[] = [];
    /** In-flight tool calls by stream index; args accumulate across deltas. */
    const pendingTools = new Map<number, { id: string; name: string; args: string }>();

    const finalizeTool = (index: number): ToolUseBlock | undefined => {
      const pending = pendingTools.get(index);
      if (!pending) return undefined;
      pendingTools.delete(index);
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(pending.args || "{}");
      } catch { /* malformed args — pass empty */ }
      const block: ToolUseBlock = {
        type: "tool_use",
        id: pending.id,
        name: pending.name,
        input,
      };
      finishedTools.push(block);
      return block;
    };

    for await (const chunk of stream) {
      // With include_usage the last chunk has empty `choices` and real `usage`.
      if (chunk.usage) usage = openaiUsage(chunk.usage);
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      // OpenRouter surfaces reasoning-model traces as a nonstandard `reasoning`
      // string on the delta; absent (undefined) on vanilla OpenAI.
      const reasoning = (delta as { reasoning?: unknown }).reasoning;
      if (typeof reasoning === "string" && reasoning) {
        thinking += reasoning;
        yield { type: "thinking_delta", text: reasoning };
      }
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        yield { type: "text_delta", text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        // Tool calls stream in index order, so a delta for a new index means
        // every lower index is complete — emit those live (the args of the
        // current index are only known-complete at stream end).
        for (const idx of [...pendingTools.keys()].filter((i) => i < tc.index).sort((a, b) => a - b)) {
          const block = finalizeTool(idx);
          if (block) yield { type: "tool_use_start", block };
        }
        let pending = pendingTools.get(tc.index);
        if (!pending) {
          pending = { id: tc.id ?? `call_${tc.index}`, name: "", args: "" };
          pendingTools.set(tc.index, pending);
        }
        if (tc.id) pending.id = tc.id;
        if (tc.function?.name) pending.name += tc.function.name;
        if (tc.function?.arguments) pending.args += tc.function.arguments;
      }
      if (choice.finish_reason) {
        stopReason = OPENAI_STOP_MAP[choice.finish_reason] ?? "end_turn";
      }
    }

    for (const idx of [...pendingTools.keys()].sort((a, b) => a - b)) {
      const block = finalizeTool(idx);
      if (block) yield { type: "tool_use_start", block };
    }

    const content: (TextBlock | ToolUseBlock)[] = [];
    if (text) content.push({ type: "text", text });
    content.push(...finishedTools);

    yield {
      type: "done",
      response: {
        content,
        stopReason: stopReason ?? "end_turn",
        thinking: thinking || undefined,
        usage,
      },
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────────

/**
 * Provider tag as it appears in SpacetimeDB's `InferenceProvider` enum.
 * (Note: Spacetime spells it `OpenAi` / `OpenAiCompatible`, not `OpenAI`.)
 */
export type ProviderTag = "Anthropic" | "OpenAi" | "Ollama" | "OpenAiCompatible";

/** Legacy alias used by self-hosted env-var bootstrap (`createProvider`). */
export type ProviderType = ProviderTag;

/**
 * Shape of an AiUserConfig row visible from an AI-user-scoped connection.
 * The `client_visibility_filter` ensures only the AI user's own row is in
 * the local cache.
 */
export interface AiUserConfigRow {
  id: bigint;
  identity: { toHexString(): string };
  createdBy: { toHexString(): string };
  provider: { tag: ProviderTag };
  model: string;
  endpoint: string | undefined;
  apiKey: string | undefined;
  systemPrompt: string | undefined;
  maxTokens: number;
  /** Optional bridge-device transport binding (see bridge-inference.ts). */
  inferenceBackendJson?: string | undefined;
}

/**
 * Create an inference provider from env-var API keys.
 * Used by orcha task fallbacks and self-hosted single-tenant deployments.
 * Conversation handlers should always use {@link createProviderFromConfig}.
 */
export function createProvider(
  providerName: ProviderTag,
  endpoint?: string,
): InferenceProvider {
  switch (providerName) {
    case "Anthropic": {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY not set");
      return new AnthropicProvider(key);
    }
    case "OpenAi": {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY not set");
      return new OpenAIProvider(key);
    }
    case "Ollama": {
      const base =
        endpoint || process.env.OLLAMA_ENDPOINT || "http://localhost:11434/v1";
      return new OpenAIProvider("ollama", base);
    }
    case "OpenAiCompatible": {
      const key = process.env.OPENAI_COMPATIBLE_API_KEY || "no-key";
      if (!endpoint)
        throw new Error("Endpoint required for OpenAI-compatible provider");
      return new OpenAIProvider(key, endpoint);
    }
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}

/**
 * Create an inference provider from an AiUserConfig row (per-user API keys).
 * Throws if the config has no api_key and the provider requires one.
 */
export function createProviderFromConfig(
  config: AiUserConfigRow,
): InferenceProvider {
  const providerName = config.provider.tag;
  const apiKey = config.apiKey;
  const endpoint = config.endpoint;

  switch (providerName) {
    case "Anthropic": {
      if (!apiKey)
        throw new Error(`AI user ${config.id}: Anthropic API key not set`);
      return new AnthropicProvider(apiKey);
    }
    case "OpenAi": {
      if (!apiKey)
        throw new Error(`AI user ${config.id}: OpenAI API key not set`);
      return new OpenAIProvider(apiKey, endpoint);
    }
    case "Ollama": {
      const base = endpoint || "http://localhost:11434/v1";
      return new OpenAIProvider("ollama", base);
    }
    case "OpenAiCompatible": {
      if (!endpoint)
        throw new Error(
          `AI user ${config.id}: endpoint required for OpenAI-compatible provider`,
        );
      return new OpenAIProvider(apiKey || "no-key", endpoint);
    }
    default:
      throw new Error(`Unknown provider: ${providerName}`);
  }
}

/** Resolved provider bundle for an AI user. */
export interface ResolvedProvider {
  provider: InferenceProvider;
  model: string;
  maxTokens: number;
  /** Catalog family — drives tier/model routing (model-catalog.ts). Endpoint-
   * aware: an OpenAI-compatible config pointed at openrouter.ai resolves to
   * the "OpenRouter" family so tier routing maps to vendor-prefixed slugs. */
  providerTag: CatalogFamily;
}

/**
 * Cached provider instances scoped to the AI user's authenticated connection.
 *
 * `ai_user_config.id` is only unique inside one workspace, so a process-global
 * Map keyed by ID can leak one workspace's provider/key into another workspace
 * whose AI user has the same auto-incremented ID.
 */
const providerCaches = new WeakMap<object, Map<bigint, ResolvedProvider>>();

/** Invalidate one connection's cached provider after config update/delete. */
export function invalidateProviderCache(conn: object, aiUserId: bigint): void {
  providerCaches.get(conn)?.delete(aiUserId);
}

/** Drop all cached providers owned by a disconnected AI-user connection. */
export function clearProviderCache(conn: object): void {
  providerCaches.delete(conn);
}

/**
 * Resolve a provider for a specific AI user. Must be called from an
 * AI-user-scoped connection — the `client_visibility_filter` on
 * `ai_user_config` ensures the only row visible is the AI user's own.
 *
 * Throws if the row is missing (not subscribed yet, or schema drift)
 * or has no api_key. There is no env-var fallback by design.
 */
export function getProviderForAiUser(
  conn: { db: Record<string, unknown> },
  aiUserId: bigint,
): ResolvedProvider {
  let providerCache = providerCaches.get(conn);
  if (!providerCache) {
    providerCache = new Map<bigint, ResolvedProvider>();
    providerCaches.set(conn, providerCache);
  }
  const cached = providerCache.get(aiUserId);
  if (cached) return cached;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configTable = (conn.db as any).ai_user_config;
  if (!configTable) {
    throw new Error(
      `[providers] ai_user_config table is not present in module bindings`,
    );
  }

  const config = configTable.id?.find(aiUserId) as AiUserConfigRow | undefined;
  if (!config) {
    throw new Error(
      `[providers] no ai_user_config row visible for AI user ${aiUserId} — ` +
        `the worker may not be connected as the AI user, or the subscription ` +
        `hasn't applied yet`,
    );
  }

  // Bridge-device transport binding: completions route through a paired
  // device's local providers (claude -p / codex / ollama) instead of a cloud
  // key. Chat-only + non-streaming in v1 (see bridge-inference.ts); an offline
  // device fails the turn explicitly — never a silent cloud fallback.
  const bridgeBinding = parseBridgeBackendBinding(config.inferenceBackendJson);
  if (bridgeBinding) {
    const entry: ResolvedProvider = {
      provider: new BridgeInferenceProvider(
        conn as unknown as ConstructorParameters<typeof BridgeInferenceProvider>[0],
        config.identity.toHexString(),
        bridgeBinding,
      ),
      model: bridgeBinding.model ?? config.model,
      maxTokens: config.maxTokens || 8192,
      providerTag: bridgeCatalogFamily(bridgeBinding.provider),
    };
    providerCache.set(aiUserId, entry);
    return entry;
  }

  if (!config.apiKey && config.provider.tag !== "Ollama") {
    throw new Error(
      `[providers] AI user ${aiUserId} (${config.provider.tag}) has no API key — ` +
        `ask the workspace owner to set one in Settings → AI Users`,
    );
  }

  const entry: ResolvedProvider = {
    provider: createProviderFromConfig(config),
    model: config.model,
    maxTokens: config.maxTokens || 8192,
    providerTag: catalogFamilyFor(config.provider.tag, config.endpoint),
  };
  providerCache.set(aiUserId, entry);
  return entry;
}

/** Catalog family for a bridge-device provider slug (drives tier routing). */
function bridgeCatalogFamily(provider: string): CatalogFamily {
  switch (provider) {
    case "claude-code":
    case "claude":
      return "Anthropic";
    case "codex":
      return "OpenAi";
    default:
      return "Ollama";
  }
}

/** Convenience: get the default provider (backwards-compatible with env-var config). */
export function getDefaultProvider(): { provider: InferenceProvider; model: string; plannerModel: string; maxTokens: number } {
  const provider = createProvider("Anthropic");
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  const plannerModel = process.env.ANTHROPIC_PLANNER_MODEL || model;
  const maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS ?? 8192);
  return { provider, model, plannerModel, maxTokens };
}
