/**
 * Voice calls with an AI user.
 *
 * The call runs in the page: it records a spoken turn, asks for the spoken
 * reply, the transcript and the notes, and plays the reply. The three model
 * requests go through a host that attaches the AI user's key (see `host.ts`),
 * so the page never holds it. Only `browserAudio.ts` touches the browser's
 * audio devices; everything else is plain logic.
 */
export * from "./types";
export { REPLY_SAMPLE_RATE, base64ToBytes, bytesToBase64, createSilenceTracker } from "./audio";
export { createBrowserCallAudio } from "./browserAudio";
export type { BrowserCallAudio } from "./browserAudio";
export { VoiceCall, callRecordMessage } from "./call";
export type { CallAudioOut, CallState, CallStatus, CallTurnView, VoiceCallOptions } from "./call";
export { UPLOAD_SAMPLE_RATE, blockRms, createTurnDetector, encodeWav, pcm16ToFloat32 } from "./capture";
export type { TurnDetector, TurnDetectorEvent, TurnDetectorOptions } from "./capture";
export { SHEET_COLUMNS, decisionWrites, isCallSheet, readCallSheet, sheetColumns } from "./sheet";
export type { CallSheet, SheetColumn, SheetDefinition, SheetRow, SheetValue } from "./sheet";
export { NOTES_SYSTEM_PROMPT, openingInstruction, talkerSystemPrompt } from "./prompts";
export { fetchVoiceAvailability, hostVoiceUpstream } from "./host";
export type { VoiceAvailability } from "./host";
export { takeVoiceNotes } from "./notes";
export { runVoiceTurn, transcribe } from "./turn";
export type { VoiceTurnOptions } from "./turn";
