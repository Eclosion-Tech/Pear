/**
 * Provider-agnostic inference abstraction.
 *
 * Normalized message types sit close to Anthropic's format (content blocks,
 * tool_use / tool_result). Each provider converts to/from its native API.
 *
 * API keys come from env vars for now. When AiUserConfig credentials are
 * readable by the worker (via SpacetimeDB procedures or a secure relay),
 * the factory will accept per-user keys instead.
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

export type UserMessage = {
  role: "user";
  content: string | ToolResultBlock[];
};
export type AssistantMessage = {
  role: "assistant";
  content: (TextBlock | ToolUseBlock)[];
};
export type Message = UserMessage | AssistantMessage;

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export interface ChatRequest {
  model: string;
  maxTokens: number;
  system: string;
  messages: Message[];
  tools?: ToolDef[];
}

export interface ChatResponse {
  content: (TextBlock | ToolUseBlock)[];
  stopReason: string;
  thinking?: string;
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

class AnthropicProvider implements InferenceProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const params: Anthropic.Messages.MessageCreateParams = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages as Anthropic.Messages.MessageParam[],
    };
    if (request.tools?.length) {
      params.tools = request.tools as Anthropic.Messages.Tool[];
    }

    const response = await this.client.messages.create(params);

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
    };
  }

  async *chatStream(request: ChatStreamRequest): AsyncIterable<StreamEvent> {
    const params: Anthropic.Messages.MessageStreamParams = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
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
      { role: "system", content: request.system },
    ];

    for (const msg of request.messages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          messages.push({ role: "user", content: msg.content });
        } else {
          for (const block of msg.content) {
            messages.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
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
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────────

export type ProviderType = "Anthropic" | "OpenAI" | "Ollama" | "OpenAI Compatible";

/**
 * Create an inference provider from a provider name.
 *
 * API keys are read from env vars. Per-AI-user key storage will replace
 * this once the worker can read AiUserConfig via procedures.
 */
export function createProvider(
  providerName: ProviderType,
  endpoint?: string
): InferenceProvider {
  switch (providerName) {
    case "Anthropic": {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY not set");
      return new AnthropicProvider(key);
    }
    case "OpenAI": {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY not set");
      return new OpenAIProvider(key);
    }
    case "Ollama": {
      const base = endpoint || process.env.OLLAMA_ENDPOINT || "http://localhost:11434/v1";
      return new OpenAIProvider("ollama", base);
    }
    case "OpenAI Compatible": {
      const key = process.env.OPENAI_COMPATIBLE_API_KEY || "no-key";
      if (!endpoint) throw new Error("Endpoint required for OpenAI Compatible provider");
      return new OpenAIProvider(key, endpoint);
    }
    default:
      throw new Error(`Unknown provider: ${providerName}`);
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
