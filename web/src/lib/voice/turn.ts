import { base64ToBytes, bytesToBase64, concatBytes, createSilenceTracker } from "./audio";
import { openingInstruction, talkerSystemPrompt } from "./prompts";
import type { VoiceEvent, VoiceModels, VoiceTiming, VoiceTurnInput, VoiceTurnResult, VoiceUpstream } from "./types";
import { isOpenRouter, readEvents, upstreamError, upstreamHeaders, upstreamUrl } from "./upstream";

export interface VoiceTurnOptions {
  upstream: VoiceUpstream;
  models: VoiceModels;
  input: VoiceTurnInput;
  /** Called with each event as it happens, in order. */
  emit: (event: VoiceEvent) => void;
  /** Aborted when the caller interrupts the reply or leaves. */
  signal?: AbortSignal;
  /**
   * Stop a reply after this much trailing silence. The longest pause seen
   * inside speech was 1.4 s, so keep it above that. Zero turns it off.
   */
  silenceCutMs?: number;
  /** Spoken output is capped in tokens too. */
  maxReplyTokens?: number;
  /** How long to wait for the transcript after the reply has ended. */
  transcriptGraceMs?: number;
}

const DEFAULT_SILENCE_CUT_MS = 2000;
const DEFAULT_MAX_REPLY_TOKENS = 500;
const DEFAULT_TRANSCRIPT_GRACE_MS = 5000;

interface Reply {
  said: string;
  usage: unknown;
  timing: VoiceTiming;
}

/**
 * Streams one spoken reply from the talker. Audio is passed on only when it
 * is safe to play: silence is held back until speech follows it, so a reply
 * that trails off into silence never reaches the caller, and the stream is
 * stopped once the silence has run long enough.
 */
async function talk(options: VoiceTurnOptions, signal: AbortSignal): Promise<Reply> {
  const { upstream, models, input, emit } = options;
  const silenceCutMs = options.silenceCutMs ?? DEFAULT_SILENCE_CUT_MS;
  const maxTokens = options.maxReplyTokens ?? DEFAULT_MAX_REPLY_TOKENS;
  const last = input.audio
    ? { role: "user", content: [{ type: "input_audio", input_audio: { data: bytesToBase64(input.audio), format: "wav" } }] }
    : { role: "user", content: openingInstruction(input.items.length) };
  const body: Record<string, unknown> = {
    model: models.talker,
    stream: true,
    temperature: 0.4,
    modalities: ["text", "audio"],
    audio: { voice: input.voice, format: "pcm16" },
    messages: [
      { role: "system", content: talkerSystemPrompt(input) },
      // Earlier turns go up as text. Only the turn being answered is audio.
      ...input.history.map((turn) => ({ role: turn.role, content: turn.text })),
      last,
    ],
  };
  if (isOpenRouter(upstream)) {
    body.max_tokens = maxTokens;
    body.usage = { include: true };
  } else {
    body.max_completion_tokens = maxTokens;
    body.stream_options = { include_usage: true };
  }

  const startedAt = Date.now();
  const res = await (upstream.fetch ?? fetch)(upstreamUrl(upstream, "talk"), {
    method: "POST",
    headers: upstreamHeaders(upstream),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await upstreamError(res));

  const tracker = createSilenceTracker();
  let held: Uint8Array[] = []; // audio since the last speech, not yet passed on
  let carry: Uint8Array | null = null; // an odd trailing byte, so every chunk passed on holds whole samples
  let said = "";
  let text = "";
  let usage: unknown = null;
  let firstAudioMs: number | null = null;
  let cut = false;
  let streamError: string | null = null;

  await readEvents(res, (json) => {
    const error = json.error as { message?: string } | undefined;
    if (error) streamError = error.message ?? JSON.stringify(error);
    if (json.usage) usage = json.usage;
    const choices = json.choices as Array<{ delta?: { content?: string; audio?: { data?: string; transcript?: string } } }> | undefined;
    const delta = choices?.[0]?.delta;
    if (!delta) return false;
    if (delta.content) text += delta.content;
    if (delta.audio?.transcript) {
      said += delta.audio.transcript;
      emit({ type: "said", text: delta.audio.transcript });
    }
    if (delta.audio?.data) {
      // Each chunk is decoded on its own: chunks need not split on base64 boundaries of the whole.
      let bytes = base64ToBytes(delta.audio.data);
      if (carry) bytes = concatBytes(carry, bytes);
      carry = bytes.length % 2 ? bytes.slice(bytes.length - 1) : null;
      if (carry) bytes = bytes.subarray(0, bytes.length - 1);
      if (bytes.length === 0) return false;
      const loud = tracker.push(bytes);
      if (loud || !tracker.heardSpeech) {
        if (firstAudioMs == null) firstAudioMs = Date.now() - startedAt;
        for (const chunk of held) emit({ type: "audio", data: bytesToBase64(chunk) });
        held = [];
        emit({ type: "audio", data: bytesToBase64(bytes) });
      } else {
        held.push(bytes);
      }
      if (silenceCutMs > 0 && tracker.trailingSilenceMs >= silenceCutMs) {
        cut = true;
        return true;
      }
    }
    return false;
  });

  if (firstAudioMs == null && !signal.aborted) {
    throw new Error(streamError ?? `the model returned no audio${text ? ` (text only: ${text.slice(0, 80)})` : ""}`);
  }
  return {
    said: (said || text).trim(),
    usage,
    timing: { firstAudioMs, totalMs: Date.now() - startedAt, speechMs: tracker.speechMs, cutForSilence: cut },
  };
}

/** What the caller said, as text. Empty when the clip has no words in it. */
export async function transcribe(upstream: VoiceUpstream, model: string, wav: Uint8Array, signal?: AbortSignal): Promise<string> {
  const doFetch = upstream.fetch ?? fetch;
  let res: Response;
  if (isOpenRouter(upstream)) {
    res = await doFetch(upstreamUrl(upstream, "transcribe"), {
      method: "POST",
      headers: upstreamHeaders(upstream),
      body: JSON.stringify({ model, input_audio: { data: bytesToBase64(wav), format: "wav" }, language: "en" }),
      signal,
    });
  } else {
    const form = new FormData();
    form.append("file", new Blob([wav as BlobPart], { type: "audio/wav" }), "turn.wav");
    form.append("model", model);
    form.append("language", "en");
    res = await doFetch(upstreamUrl(upstream, "transcribe"), {
      method: "POST",
      headers: upstreamHeaders(upstream, null), // the browser sets the multipart boundary
      body: form,
      signal,
    });
  }
  if (!res.ok) throw new Error(await upstreamError(res));
  const json = (await res.json()) as { text?: unknown };
  if (typeof json.text !== "string") throw new Error("no text in the transcription response");
  return json.text.trim();
}

/**
 * Runs one turn of a call: the spoken reply, and alongside it the transcript
 * of what the caller said.
 *
 * A sound with no words in it (a cough, a door, the assistant's own voice
 * through the speakers) can set a microphone off. When the transcript comes
 * back empty the turn is void: a `noise` event is emitted and the reply is
 * stopped.
 */
export async function runVoiceTurn(options: VoiceTurnOptions): Promise<VoiceTurnResult> {
  const { upstream, models, input, emit } = options;
  const controller = new AbortController();
  const callerLeft = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", callerLeft, { once: true });

  let noise = false;
  let heardText: string | null = null;
  const heard: Promise<void> = input.audio
    ? transcribe(upstream, models.transcribe, input.audio).then(
        (text) => {
          if (!text) {
            noise = true;
            emit({ type: "noise" });
            controller.abort();
            return;
          }
          heardText = text;
          emit({ type: "heard", text });
        },
        (error: unknown) => {
          emit({ type: "heard", text: null, error: error instanceof Error ? error.message : String(error) });
        },
      )
    : Promise.resolve();

  const result: VoiceTurnResult = { said: "", heard: null, noise: false, timing: null, usage: null };
  try {
    const reply = await talk(options, controller.signal);
    result.said = reply.said;
    result.timing = reply.timing;
    result.usage = reply.usage;
    if (!noise) emit({ type: "done", timing: reply.timing, usage: reply.usage });
  } catch (error) {
    const callerGone = options.signal?.aborted === true;
    if (!callerGone && !noise) {
      result.error = error instanceof Error ? error.message : String(error);
      emit({ type: "error", message: result.error });
    }
  } finally {
    options.signal?.removeEventListener("abort", callerLeft);
  }

  // The transcript is usually back long before the reply ends. Wait for it,
  // briefly, so the caller always learns what was heard.
  const grace = options.transcriptGraceMs ?? DEFAULT_TRANSCRIPT_GRACE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([heard, new Promise<void>((resolve) => { timer = setTimeout(resolve, grace); })]);
  if (timer) clearTimeout(timer);

  result.heard = heardText;
  result.noise = noise;
  return result;
}
