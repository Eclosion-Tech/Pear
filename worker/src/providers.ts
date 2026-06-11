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
    if (request.thinkingBudget) {
      params.thinking = { type: "enabled", budget_tokens: request.thinkingBudget };
    }

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

class OpenAIProvider implements InferenceProvider {
  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
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

    const params: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
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

    const response = await this.client.chat.completions.create(params);
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

    const stopMap: Record<string, string> = {
      stop: "end_turn",
      tool_calls: "tool_use",
      length: "max_tokens",
    };

    return {
      content,
      stopReason: stopMap[choice.finish_reason ?? "stop"] ?? "end_turn",
      usage: openaiUsage(response.usage),
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
  /** Provider family tag — drives utility-model selection (model-catalog.ts). */
  providerTag: ProviderTag;
}

/** Cached provider instances keyed by AI user ID. */
const providerCache = new Map<bigint, ResolvedProvider>();

/** Invalidate cached provider for an AI user (call on ai_user_config update/delete). */
export function invalidateProviderCache(aiUserId: bigint): void {
  providerCache.delete(aiUserId);
}

/** Clear the entire provider cache (call on disconnect). */
export function clearProviderCache(): void {
  providerCache.clear();
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
    providerTag: config.provider.tag,
  };
  providerCache.set(aiUserId, entry);
  return entry;
}

/** Convenience: get the default provider (backwards-compatible with env-var config). */
export function getDefaultProvider(): { provider: InferenceProvider; model: string; plannerModel: string; maxTokens: number } {
  const provider = createProvider("Anthropic");
  const model = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
  const plannerModel = process.env.ANTHROPIC_PLANNER_MODEL || model;
  const maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS ?? 8192);
  return { provider, model, plannerModel, maxTokens };
}
