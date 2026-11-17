import { REPLY_SAMPLE_RATE } from "./audio";
import type { CallAudioOut } from "./call";
import { pcm16ToFloat32 } from "./capture";

/**
 * The microphone and the speaker for a call, in a browser.
 *
 * Capture delivers blocks of about 20 ms. Playback queues the reply's pcm16
 * chunks back to back as they arrive, which is usually much faster than they
 * play.
 */

export interface BrowserCallAudio extends CallAudioOut {
  /** Asks for the microphone and starts delivering blocks of samples. */
  start(onBlock: (block: Float32Array) => void): Promise<void>;
  /** Releases the microphone and the audio device. */
  close(): Promise<void>;
  /** The capture rate, known once started. */
  readonly sampleRate: number;
}

// An AudioWorklet module has to be loaded from a URL. A Blob URL keeps it in
// this file, so a host application embedding Pear has no extra asset to serve.
const WORKLET_SOURCE = `
class PearVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(Math.round(sampleRate / 50));
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        this.block[this.filled] = channel[i];
        this.filled += 1;
        if (this.filled === this.block.length) {
          this.port.postMessage(this.block.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("pear-voice-capture", PearVoiceCapture);
`;

export function createBrowserCallAudio(): BrowserCallAudio {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let playing: AudioBufferSourceNode[] = [];
  let playHead = 0; // context time at which the queued audio ends
  let replyStartedAt: number | null = null; // context time the reply now playing began

  async function captureNode(context: AudioContext, onBlock: (block: Float32Array) => void): Promise<AudioNode> {
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(context, "pear-voice-capture");
      node.port.onmessage = (event: MessageEvent<Float32Array>) => onBlock(event.data);
      return node;
    } catch {
      // A content security policy can refuse a worklet from a Blob URL. The
      // older processor node does the same job on the main thread.
      const node = context.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = (event) => onBlock(new Float32Array(event.inputBuffer.getChannelData(0)));
      return node;
    }
  }

  return {
    async start(onBlock) {
      if (ctx) {
        await ctx.resume();
        return;
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      const context = new AudioContext({ latencyHint: "interactive" });
      ctx = context;
      const node = await captureNode(context, onBlock);
      context.createMediaStreamSource(stream).connect(node);
      // Routed to the output at zero volume so every browser keeps the node running.
      const mute = context.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(context.destination);
    },

    play(pcm) {
      if (!ctx) return 0;
      const samples = pcm16ToFloat32(pcm);
      if (samples.length === 0) return 0;
      const buffer = ctx.createBuffer(1, samples.length, REPLY_SAMPLE_RATE);
      buffer.getChannelData(0).set(samples);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const startAt = Math.max(ctx.currentTime + 0.02, playHead);
      if (replyStartedAt === null || ctx.currentTime >= playHead) replyStartedAt = startAt;
      source.start(startAt);
      playHead = startAt + buffer.duration;
      playing.push(source);
      source.onended = () => {
        playing = playing.filter((s) => s !== source);
      };
      return Math.max(0, (startAt - ctx.currentTime) * 1000);
    },

    stop() {
      if (!ctx) return 0;
      const played = replyStartedAt === null ? 0 : Math.max(0, Math.min(ctx.currentTime, playHead) - replyStartedAt) * 1000;
      for (const source of playing) {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      }
      playing = [];
      playHead = ctx.currentTime;
      replyStartedAt = null;
      return Math.round(played);
    },

    get playing() {
      // A short margin, so the tail of a reply still counts while it fades.
      return ctx !== null && ctx.currentTime < playHead + 0.15;
    },

    get sampleRate() {
      return ctx?.sampleRate ?? 48_000;
    },

    async close() {
      this.stop();
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      const context = ctx;
      ctx = null;
      if (context && context.state !== "closed") await context.close().catch(() => undefined);
    },
  };
}
