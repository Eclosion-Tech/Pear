/**
 * Small audio helpers that run anywhere Web APIs do: the browser, Node and
 * Cloudflare Workers. No Buffer.
 */

/** The talker's pcm16 output: 24 kHz, mono, 16-bit little-endian. */
export const REPLY_SAMPLE_RATE = 24_000;
const BYTES_PER_MS = (REPLY_SAMPLE_RATE * 2) / 1000;
const WINDOW_MS = 100;
const WINDOW_BYTES = WINDOW_MS * BYTES_PER_MS;

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // In pieces, so a large clip does not overflow the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export interface SilenceTracker {
  /** Feed pcm16 bytes. True when they contained speech. */
  push(chunk: Uint8Array): boolean;
  readonly heardSpeech: boolean;
  /** Length of audio up to the end of the last speech. */
  readonly speechMs: number;
  /** Silence since the last speech. Zero until speech has been heard. */
  readonly trailingSilenceMs: number;
}

/**
 * Follows the loudness of a pcm16 stream in 100 ms windows. A window counts
 * as speech when it is louder than 2% of the loudest window so far and above
 * a small floor. In recorded replies speech peaks near 8000 and the silence a
 * reply sometimes trails off into stays under about 100.
 */
export function createSilenceTracker(): SilenceTracker {
  let pending: Uint8Array = new Uint8Array(0);
  let windows = 0;
  let peak = 0;
  let lastLoud = -1;
  let silentRun = 0;
  return {
    push(chunk) {
      let loud = false;
      pending = pending.length ? concatBytes(pending, chunk) : chunk;
      while (pending.length >= WINDOW_BYTES) {
        const view = new DataView(pending.buffer, pending.byteOffset, WINDOW_BYTES);
        let sum = 0;
        for (let i = 0; i < WINDOW_BYTES; i += 2) {
          const sample = view.getInt16(i, true);
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / (WINDOW_BYTES / 2));
        pending = pending.subarray(WINDOW_BYTES);
        if (rms > peak) peak = rms;
        if (rms > Math.max(peak * 0.02, 150)) {
          lastLoud = windows;
          silentRun = 0;
          loud = true;
        } else {
          silentRun += 1;
        }
        windows += 1;
      }
      return loud;
    },
    get heardSpeech() {
      return lastLoud >= 0;
    },
    get speechMs() {
      return (lastLoud + 1) * WINDOW_MS;
    },
    get trailingSilenceMs() {
      return lastLoud >= 0 ? silentRun * WINDOW_MS : 0;
    },
  };
}
