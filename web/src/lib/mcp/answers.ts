/** Host-backed, explicitly scoped answer API. No inference implementation or credentials here. */
import type { McpContext, McpToolEntry } from "./types";
import { validAnswerInput, type AnswerAction } from "./answer-contract";
export { validAnswerInput } from "./answer-contract";
export function answerTools(): McpToolEntry[] {
  const entry = (
    name: string,
    action: AnswerAction,
    properties: NonNullable<McpToolEntry["inputSchema"]["properties"]>,
    required: string[],
    description: string,
  ): McpToolEntry => ({
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    async execute(ctx: McpContext, input) {
      if (!validAnswerInput(action, input))
        return JSON.stringify({ ok: false, error: "invalid_answer_request" });
      if (!ctx.answers)
        return JSON.stringify({ ok: false, error: "answer_api_unavailable" });
      try {
        return JSON.stringify(await ctx.answers.invoke(action, input));
      } catch {
        return JSON.stringify({
          ok: false,
          error:
            action === "run"
              ? "answer_outcome_unknown_no_retry"
              : "answer_api_unavailable",
        });
      }
    },
  });
  return [
    entry(
      "list_answer_workers",
      "list",
      {},
      [],
      "List eligible Claude text-only workers. No classifier, authentication preflight or inference.",
    ),
    entry(
      "prepare_answer",
      "prepare",
      {
        profileId: { type: "string" },
        text: { type: "string", maxLength: 8192 },
      },
      ["profileId", "text"],
      "Prepare a five-minute immutable answer offer with approved:false. Only the supplied text is used; no inference.",
    ),
    entry(
      "run_answer",
      "run",
      {
        approvalId: { type: "string" },
        offerFingerprint: { type: "string" },
        approved: { const: true, type: "boolean" },
      },
      ["approvalId", "offerFingerprint", "approved"],
      "Consume a previously displayed, explicitly confirmed offer once. At most one tool-less Claude attempt; no retry, fallback or remote cancellation. The client is responsible for genuine human confirmation.",
    ),
    entry(
      "get_answer",
      "get",
      { approvalId: { type: "string" } },
      ["approvalId"],
      "Read only this connection’s answer status/result. Never starts, resumes or retries execution.",
    ),
  ];
}
