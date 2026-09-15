import type { ChatStreamRequest, ChatResponse } from "./providers.js";
import { effortSupportFor } from "./model-catalog.js";

/** Reuse the request and completed tool history; never replay raw reasoning. */
export function answerRecoveryRequest(request: ChatStreamRequest, providerTag: string): ChatStreamRequest | undefined {
  if (providerTag === "Anthropic") {
    // The adapter enables thinking only when a budget or effort is supplied.
    // Adaptive thinking does not enforce the explicit thinking budget.
    return { ...request, thinkingBudget: undefined, effort: undefined };
  }
  const support = effortSupportFor(request.model);
  if (support.kind !== "openai_reasoning_effort") return undefined;
  const effort = support.levels?.includes("none") ? "none"
    : support.levels?.includes("low") ? "low" : undefined;
  return effort ? { ...request, thinkingBudget: undefined, effort } : undefined;
}

export function isThinkingOnlyExhaustion(response: ChatResponse, visibleText: string, sawTool: boolean): boolean {
  return response.stopReason === "max_tokens" && !visibleText.trim() && !sawTool
    && !response.content.some(block => block.type === "tool_use" || (block.type === "text" && block.text.trim()));
}

export function emptyAnswerMessage(truncated: boolean): string {
  return truncated
    ? "I reached the response length limit before producing an answer. Please retry with a lower reasoning effort or a different model."
    : "The model finished without producing an answer. Please retry or choose a different model.";
}
