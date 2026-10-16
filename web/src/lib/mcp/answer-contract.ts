/** Portable answer API vocabulary/validation; no UI, runtime SDK or credentials. */
export type AnswerAction = "list" | "prepare" | "run" | "get";
export interface AnswerApi {
  invoke(
    action: AnswerAction,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const fields = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).sort().join() === names.sort().join();
export function validAnswerInput(
  action: AnswerAction,
  input: Record<string, unknown>,
): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const required =
    action === "list"
      ? []
      : action === "prepare"
        ? ["profileId", "text"]
        : action === "get"
          ? ["approvalId"]
          : ["approvalId", "offerFingerprint", "approved"];
  return (
    fields(input, required) &&
    (action === "list" || action === "prepare"
      ? action === "list" ||
        (typeof input.text === "string" &&
          input.text.trim().length > 0 &&
          new TextEncoder().encode(input.text).length <= 8192 &&
          typeof input.profileId === "string" &&
          /^bridge_[1-9][0-9]*_claude-code$/.test(input.profileId))
      : typeof input.approvalId === "string" &&
        uuid.test(input.approvalId) &&
        (action === "get" ||
          (input.approved === true &&
            typeof input.offerFingerprint === "string" &&
            hash.test(input.offerFingerprint))))
  );
}
