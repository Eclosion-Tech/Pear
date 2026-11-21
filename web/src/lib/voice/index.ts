/**
 * Voice calls with an AI user: the parts that are Pear's own.
 *
 * The call itself (one spoken turn, turn detection, playback, the call
 * session) is `@eclosion-tech/chat-voice`. What lives here is how a call
 * connects to Pear:
 *
 * - `thread.ts`: the call and the conversation it belongs to. The latest
 *   messages go in as context, and what the caller asks for is sent to the AI
 *   user as a message, whose answer comes back to the call.
 * - `sheet.ts`: an agenda is an ordinary Pear database.
 * - `host.ts`: the model requests go through the host's AI-user API, which
 *   attaches the AI user's model key, so the page never holds it.
 */
export { fetchVoiceAvailability, hostVoiceUpstream } from "./host";
export type { VoiceAvailability } from "./host";
export { newestMessageId, recentTurns, settleRequests, voiceRequestMessage } from "./thread";
export type { PendingRequest, RequestOutcome, ThreadMessage } from "./thread";
export { SHEET_COLUMNS, decisionWrites, isCallSheet, readCallSheet, sheetColumns } from "./sheet";
export type { CallSheet, SheetColumn, SheetDefinition, SheetRow, SheetValue } from "./sheet";
