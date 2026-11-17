/**
 * Shared types for voice calls with an AI user.
 *
 * A call walks through a call sheet: a short list of items, each one thing to
 * ask the caller. The server side is stateless. The page holds the state of
 * the call (the sheet, what was said so far, what has been decided) and sends
 * it with every turn.
 */

/** One thing to raise on a call. */
export interface CallItem {
  /** Stable within a sheet. Never spoken. */
  id: string;
  title: string;
  /** What to ask, in words meant to be spoken. */
  say: string;
  recommendation: string;
  /** Background for follow-up questions. */
  detail: string;
  /** Where the item came from, for whoever applies the answer later. */
  source?: string;
}

export interface CallDecision {
  /** One plain sentence stating what the caller decided or answered. */
  decision: string;
  /** The caller's words, as transcribed. */
  quote?: string;
}

/** An earlier turn of the call, as text. */
export interface CallTurn {
  role: "assistant" | "user";
  text: string;
}

export interface VoiceModels {
  /** Audio in, audio out. */
  talker: string;
  transcribe: string;
  /** Text model that records which item an answer belongs to. */
  notes: string;
}

/**
 * Where the three model calls go. Either an OpenAI-compatible endpoint that
 * the caller holds a key for, or a host that attaches the AI user's key
 * itself, in which case there is no key here and the host names the paths.
 */
export interface VoiceUpstream {
  baseUrl: string;
  /** Absent when the host attaches the key. */
  apiKey?: string;
  /** Which request fields to use. Inferred from the base URL when absent. */
  dialect?: "openrouter" | "openai";
  /** Paths under the base URL. Default to the OpenAI-compatible ones. */
  paths?: { talk?: string; transcribe?: string; notes?: string };
  /** Replaceable for tests, and for a host that needs credentials sent. */
  fetch?: typeof fetch;
}

export interface VoiceTiming {
  /** Request sent to first audio passed on. */
  firstAudioMs: number | null;
  totalMs: number;
  /** Length of the speech passed on, excluding trailing silence. */
  speechMs: number;
  /** The reply trailed off into silence and the stream was stopped. */
  cutForSilence: boolean;
}

/** One line of the streamed response to a turn. */
export type VoiceEvent =
  /** Base64 of 24 kHz mono 16-bit PCM, always whole samples. */
  | { type: "audio"; data: string }
  /** The assistant's words, in pieces, usually ahead of the audio. */
  | { type: "said"; text: string }
  /** What the caller said. Null when it could not be transcribed. */
  | { type: "heard"; text: string | null; error?: string }
  /** The capture had no words in it. The turn is void and the reply stops. */
  | { type: "noise" }
  | { type: "done"; timing: VoiceTiming; usage: unknown }
  | { type: "error"; message: string };

export interface VoiceTurnInput {
  /** Name the assistant goes by on the call. */
  assistantName?: string;
  items: CallItem[];
  /** Decisions so far, by item id. */
  decisions: Record<string, CallDecision>;
  history: CallTurn[];
  /** The caller's turn as a WAV file. Absent for the opening turn. */
  audio?: Uint8Array;
  voice: string;
}

export interface VoiceTurnResult {
  said: string;
  /** Null when there was no caller audio or it could not be transcribed. */
  heard: string | null;
  noise: boolean;
  timing: VoiceTiming | null;
  usage: unknown;
  error?: string;
}

export interface VoiceNotesInput {
  items: CallItem[];
  /** Ids of items already recorded. */
  alreadyRecorded: string[];
  assistantAsked: string | null;
  callerSaid: string;
  assistantReplied?: string | null;
}

export interface VoiceNotes {
  decisions: Array<{ item: string; decision: string; quote: string }>;
  currentItem: string | null;
  usage: unknown;
}
