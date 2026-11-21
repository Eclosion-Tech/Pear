import type { CallTurn } from "@eclosion-tech/chat-voice";

/**
 * A call and the written conversation it belongs to.
 *
 * The voice model on a call is fast and has no tools. Two things connect it
 * to the AI user's real work, and both go through the conversation:
 *
 * - Going in, the latest messages are given to the call as context.
 * - During the call, anything the caller asks for that needs the workspace is
 *   written into the conversation as a message from the caller. The AI user
 *   answers it there as it would any message, and that answer is handed back
 *   to the call to be spoken.
 */

/** The parts of a conversation message this module reads. */
export interface ThreadMessage {
  id: bigint;
  conversationId: bigint;
  sender: { tag: "User"; value: { toHexString(): string } } | { tag: "System"; value: string };
  content: string;
  status: { tag: string };
}

const MAX_RECENT = 12;
const MAX_ANSWER_CHARS = 1500;

const senderHex = (message: ThreadMessage): string | null => (message.sender.tag === "User" ? message.sender.value.toHexString() : null);
const byId = (a: ThreadMessage, b: ThreadMessage) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The latest finished messages people and the AI user wrote, oldest first, as the call sees them. */
export function recentTurns(messages: readonly ThreadMessage[], args: { conversationId: bigint; aiIdentityHex: string; max?: number }): CallTurn[] {
  return messages
    .filter((message) => message.conversationId === args.conversationId && message.sender.tag === "User" && message.status.tag === "Complete" && message.content.trim())
    .sort(byId)
    .slice(-(args.max ?? MAX_RECENT))
    .map((message) => ({ role: senderHex(message) === args.aiIdentityHex ? ("assistant" as const) : ("user" as const), text: message.content }));
}

/** The id of the newest message in a conversation, or zero. A request sent now will have a greater id. */
export function newestMessageId(messages: readonly ThreadMessage[], conversationId: bigint): bigint {
  let newest = 0n;
  for (const message of messages) if (message.conversationId === conversationId && message.id > newest) newest = message.id;
  return newest;
}

/** A request from a call, as the message the caller sends to the AI user. */
export function voiceRequestMessage(text: string): string {
  return `Voice call request: ${text}\n\nI asked this out loud on a call with you. Do it as you normally would, then answer in two or three short sentences that can be read back to me.`;
}

/** A request waiting for the AI user's answer in the conversation. */
export interface PendingRequest {
  /** The request's id on the call. */
  id: string;
  /** The message it was sent as. */
  message: string;
  /** The newest message id in the conversation just before it was sent. */
  afterId: bigint;
  /** The row it was written as, once that has been seen. */
  rowId?: bigint;
}

export interface RequestOutcome {
  id: string;
  status: "answered" | "failed";
  text: string;
  /** The AI user's message that settled it. Never used for another request. */
  replyId: bigint;
}

/**
 * Matches waiting requests to the AI user's answers.
 *
 * A request's answer is the first message from the AI user after the request's
 * own row that no earlier request has taken. While that message is still
 * being written the request waits, and so does every request behind it, so
 * answers are never handed to the wrong request.
 */
export function settleRequests(args: {
  pending: readonly PendingRequest[];
  messages: readonly ThreadMessage[];
  conversationId: bigint;
  callerIdentityHex: string;
  aiIdentityHex: string;
  /** Replies already handed to a request. */
  claimed: ReadonlySet<bigint>;
}): { rows: Array<{ id: string; rowId: bigint }>; outcomes: RequestOutcome[] } {
  const thread = args.messages.filter((message) => message.conversationId === args.conversationId).sort(byId);
  const usedRows = new Set(args.pending.flatMap((request) => (request.rowId === undefined ? [] : [request.rowId])));
  const taken = new Set(args.claimed);
  const rows: Array<{ id: string; rowId: bigint }> = [];
  const outcomes: RequestOutcome[] = [];

  for (const request of args.pending) {
    let rowId = request.rowId;
    if (rowId === undefined) {
      const row = thread.find(
        (message) => message.id > request.afterId && !usedRows.has(message.id) && senderHex(message) === args.callerIdentityHex && message.content === request.message,
      );
      if (!row) continue; // not written yet
      rowId = row.id;
      usedRows.add(rowId);
      rows.push({ id: request.id, rowId });
    }
    const after = rowId;
    const reply = thread.find((message) => message.id > after && !taken.has(message.id) && senderHex(message) === args.aiIdentityHex);
    if (!reply) continue;
    // Whatever its state, this message is this request's. Nothing behind it may take it.
    taken.add(reply.id);
    if (reply.status.tag === "Error") {
      outcomes.push({ id: request.id, status: "failed", text: "it ran into an error; the details are in the chat", replyId: reply.id });
    } else if (reply.status.tag === "Complete" && reply.content.trim()) {
      const text = reply.content.trim();
      outcomes.push({ id: request.id, status: "answered", text: text.length > MAX_ANSWER_CHARS ? `${text.slice(0, MAX_ANSWER_CHARS)}…` : text, replyId: reply.id });
    }
  }
  return { rows, outcomes };
}
