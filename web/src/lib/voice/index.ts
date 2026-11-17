/**
 * Voice calls with an AI user.
 *
 * The call runs in the page: it records a spoken turn, asks for the spoken
 * reply, the transcript and the notes, and plays the reply. The three model
 * requests go through a host that attaches the AI user's key (see `host.ts`),
 * so the page never holds it. Nothing here touches the DOM; capture and
 * playback live with the component.
 */
export * from "./types";
export { REPLY_SAMPLE_RATE, base64ToBytes, bytesToBase64, createSilenceTracker } from "./audio";
export { NOTES_SYSTEM_PROMPT, openingInstruction, talkerSystemPrompt } from "./prompts";
export { fetchVoiceAvailability, hostVoiceUpstream } from "./host";
export type { VoiceAvailability } from "./host";
export { takeVoiceNotes } from "./notes";
export { runVoiceTurn, transcribe } from "./turn";
export type { VoiceTurnOptions } from "./turn";
