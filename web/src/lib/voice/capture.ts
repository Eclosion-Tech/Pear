/**
 * Turning a microphone stream into spoken turns, without touching the DOM:
 * deciding where a turn starts and ends, and encoding it for upload.
 *
 * The component feeds blocks of samples in as they arrive and acts on what
 * comes back. Keeping the decisions here makes them testable.
 */

/** What is sent up: 16 kHz mono 16-bit WAV. */
export const UPLOAD_SAMPLE_RATE = 16_000;

export interface TurnDetectorOptions {
  /** How long the caller must be quiet before the turn is taken as finished. */
  endpointMs: number;
  /** Audio kept from before speech was detected, so the first word is not clipped. */
  preRollMs?: number;
  /** Anything shorter is a noise, not a turn. */
  minSpeechMs?: number;
  /** A turn is cut off here. Also keeps the upload within the host's size limit. */
  maxTurnMs?: number;
}

export type TurnDetectorEvent =
  /** The caller started speaking. If a reply is playing, this is an interruption. */
  | { type: "speech-start" }
  /** A finished turn. `quietMs` is the wait between the last sound and this event. */
  | { type: "turn"; blocks: Float32Array[]; speechMs: number; quietMs: number }
  /** A sound too short to be a turn. */
  | { type: "discarded" };

export interface TurnDetector {
  /**
   * Feed one block of samples. `assistantAudible` is true while a reply is
   * playing; `allowInterrupt` is false when the caller has asked not to be
   * able to talk over it.
   */
  push(block: Float32Array, context: { assistantAudible: boolean; allowInterrupt: boolean }): TurnDetectorEvent | null;
  /** Loudness of the last block and the level speech must pass, for a meter. */
  readonly level: { rms: number; threshold: number };
  readonly capturing: boolean;
  setEndpointMs(ms: number): void;
  reset(): void;
}

export function blockRms(block: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < block.length; i += 1) sum += block[i] * block[i];
  return block.length ? Math.sqrt(sum / block.length) : 0;
}

/**
 * Detects turns by loudness against a noise floor that follows the room.
 *
 * While a reply is audible the bar is higher and speech must be sustained
 * for longer, so the assistant's own voice coming back through the
 * microphone is not taken for the caller.
 */
export function createTurnDetector(sampleRate: number, options: TurnDetectorOptions): TurnDetector {
  const preRollMs = options.preRollMs ?? 300;
  const minSpeechMs = options.minSpeechMs ?? 250;
  const maxTurnMs = options.maxTurnMs ?? 30_000;
  let endpointMs = options.endpointMs;

  let noiseFloor = 0.004;
  let capturing = false;
  let blocks: Float32Array[] = [];
  let preRoll: Float32Array[] = [];
  let preRollLength = 0;
  let loudMs = 0;
  let quietMs = 0;
  let speechMs = 0;
  let capturedMs = 0;
  let level = { rms: 0, threshold: 0.012 };

  const reset = () => {
    capturing = false;
    blocks = [];
    preRoll = [];
    preRollLength = 0;
    loudMs = 0;
    quietMs = 0;
    speechMs = 0;
    capturedMs = 0;
  };

  return {
    push(block, context) {
      const ms = (block.length / sampleRate) * 1000;
      const rms = blockRms(block);
      const startAt = Math.max(noiseFloor * 3.5, 0.012) * (context.assistantAudible ? 2.5 : 1);
      const stopAt = Math.max(noiseFloor * 2, 0.008);
      level = { rms, threshold: startAt };

      if (!capturing) {
        if (!context.assistantAudible && rms < startAt) noiseFloor = noiseFloor * 0.97 + rms * 0.03;
        preRoll.push(block);
        preRollLength += block.length;
        while (preRoll.length > 1 && ((preRollLength - preRoll[0].length) / sampleRate) * 1000 >= preRollMs) {
          preRollLength -= preRoll[0].length;
          preRoll.shift();
        }
        if (context.assistantAudible && !context.allowInterrupt) {
          loudMs = 0;
          return null;
        }
        loudMs = rms > startAt ? loudMs + ms : 0;
        if (loudMs < (context.assistantAudible ? 200 : 100)) return null;
        capturing = true;
        blocks = preRoll;
        capturedMs = (preRollLength / sampleRate) * 1000;
        preRoll = [];
        preRollLength = 0;
        quietMs = 0;
        speechMs = loudMs;
        return { type: "speech-start" };
      }

      blocks.push(block);
      capturedMs += ms;
      if (rms > stopAt) {
        quietMs = 0;
        speechMs += ms;
      } else {
        quietMs += ms;
      }
      if (quietMs < endpointMs && capturedMs <= maxTurnMs) return null;

      const finished = { blocks, speechMs, quietMs };
      reset();
      if (finished.speechMs < minSpeechMs) return { type: "discarded" };
      // Drop most of the trailing quiet, keeping a short tail.
      const dropMs = Math.max(0, finished.quietMs - 150);
      let kept = finished.blocks;
      if (dropMs > 0) {
        let dropped = 0;
        let end = kept.length;
        while (end > 1 && dropped + (kept[end - 1].length / sampleRate) * 1000 <= dropMs) {
          dropped += (kept[end - 1].length / sampleRate) * 1000;
          end -= 1;
        }
        kept = kept.slice(0, end);
      }
      return { type: "turn", blocks: kept, speechMs: finished.speechMs, quietMs: finished.quietMs };
    },
    get level() {
      return level;
    },
    get capturing() {
      return capturing;
    },
    setEndpointMs(ms) {
      endpointMs = ms;
    },
    reset,
  };
}

/** Blocks of samples at any rate, as a 16 kHz mono 16-bit WAV. */
export function encodeWav(blocks: readonly Float32Array[], sampleRate: number): Uint8Array {
  const total = blocks.reduce((n, block) => n + block.length, 0);
  const input = new Float32Array(total);
  let offset = 0;
  for (const block of blocks) {
    input.set(block, offset);
    offset += block.length;
  }
  // Down to the upload rate by averaging each group of input samples.
  const ratio = sampleRate / UPLOAD_SAMPLE_RATE;
  const count = Math.floor(total / ratio);
  const out = new Uint8Array(44 + count * 2);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, UPLOAD_SAMPLE_RATE, true);
  view.setUint32(28, UPLOAD_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i += 1) {
    const from = Math.floor(i * ratio);
    const to = Math.min(total, Math.max(from + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / (to - from)));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return out;
}

/** The reply's 24 kHz pcm16 bytes as samples for playback. */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength - (bytes.byteLength % 2));
  const out = new Float32Array(view.byteLength / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}
