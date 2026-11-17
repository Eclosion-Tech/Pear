/**
 * Voice calls with an AI user: the parts that are Pear's own.
 *
 * The call itself (one spoken turn, turn detection, playback, the call
 * session) is `@eclosion-tech/chat-voice`. What lives here is where a call's
 * items come from and where its model requests go:
 *
 * - `sheet.ts`: a call sheet is an ordinary Pear database.
 * - `host.ts`: the requests go through the host's AI-user API, which attaches
 *   the AI user's model key, so the page never holds it.
 */
export { fetchVoiceAvailability, hostVoiceUpstream } from "./host";
export type { VoiceAvailability } from "./host";
export { SHEET_COLUMNS, decisionWrites, isCallSheet, readCallSheet, sheetColumns } from "./sheet";
export type { CallSheet, SheetColumn, SheetDefinition, SheetRow, SheetValue } from "./sheet";
