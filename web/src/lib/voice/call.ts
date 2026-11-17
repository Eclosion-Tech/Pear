import { base64ToBytes } from "./audio";
import { takeVoiceNotes } from "./notes";
import { runVoiceTurn } from "./turn";
import type { CallDecision, CallItem, CallTurn, VoiceEvent, VoiceModels, VoiceUpstream } from "./types";

/**
 * One voice call, from the opening line to hanging up.
 *
 * Holds the state of the call (what has been said, what has been decided),
 * runs each turn, and reports every change to the component. It touches no
 * DOM: playback is behind `CallAudioOut`, and the component hands in each
 * finished turn as WAV bytes.
 */

/** Playback, as the call needs it. */
export interface CallAudioOut {
  /** Queue 24 kHz mono pcm16 for playback. Returns milliseconds until this chunk starts to play. */
  play(pcm: Uint8Array): number;
  /** Stop now and drop what is queued. Returns milliseconds of the current reply that had played. */
  stop(): number;
  /** True while queued audio is still playing. */
  readonly playing: boolean;
}

export type CallStatus = "idle" | "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "ended";

export interface CallTurnView {
  role: "assistant" | "user";
  text: string;
  /** Still arriving: a reply being spoken, or a turn being transcribed. */
  pending: boolean;
  interrupted?: boolean;
  error?: string;
  /** For a reply to a spoken turn: how long the caller waited to hear it. */
  timing?: { stoppedToReplyMs: number; waitedMs: number };
}

export interface CallState {
  status: CallStatus;
  turns: CallTurnView[];
  decisions: Record<string, CallDecision>;
  currentItem: string | null;
  /** "Caller stopped to reply started", one per answered turn. */
  gapsMs: number[];
}

export interface VoiceCallOptions {
  upstream: VoiceUpstream;
  models: VoiceModels;
  voice: string;
  assistantName?: string;
  items: CallItem[];
  /** Decisions the sheet already carries, when a call is resumed. */
  decisions?: Record<string, CallDecision>;
  audio: CallAudioOut;
  onChange: (state: CallState) => void;
  /** Called once per new decision, to persist it. A failure is reported but does not stop the call. */
  onDecision?: (itemId: string, decision: CallDecision) => void | Promise<void>;
  /** Milliseconds, monotonic. Replaceable for tests. */
  now?: () => number;
}

interface ActiveReply {
  controller: AbortController;
  view: CallTurnView;
  interrupted: boolean;
  playedMs: number;
  /** The reply as the talker will see it on later turns, once it has fully arrived. */
  remembered?: CallTurn;
}

/** What the talker is told about a reply the caller talked over. */
function interruptionNote(playedMs: number): string {
  const seconds = Math.round(playedMs / 1000);
  return ` (the caller interrupted after about ${seconds} second${seconds === 1 ? "" : "s"} of this)`;
}

const UNTRANSCRIBED = "(The caller said something that could not be transcribed.)";

export class VoiceCall {
  private readonly options: VoiceCallOptions;
  private readonly now: () => number;
  private readonly history: CallTurn[] = [];
  private readonly turns: CallTurnView[] = [];
  private readonly decisions: Record<string, CallDecision>;
  private readonly gaps: number[] = [];
  private status: CallStatus = "idle";
  private currentItem: string | null = null;
  private active: ActiveReply | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;

  constructor(options: VoiceCallOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.decisions = { ...(options.decisions ?? {}) };
  }

  get state(): CallState {
    return {
      status: this.status,
      turns: this.turns.map((turn) => ({ ...turn })),
      decisions: { ...this.decisions },
      currentItem: this.currentItem,
      gapsMs: [...this.gaps],
    };
  }

  /** The assistant opens the call. */
  start(): Promise<void> {
    if (this.status !== "idle") return Promise.resolve();
    this.setStatus("connecting");
    return this.exchange(null, 0);
  }

  /**
   * The caller finished a turn. `quietMs` is how long the detector waited
   * after their last sound, which is part of how long they wait for a reply.
   */
  submit(wav: Uint8Array, quietMs: number): Promise<void> {
    if (this.status === "idle" || this.status === "ended") return Promise.resolve();
    return this.exchange(wav, quietMs);
  }

  /** The caller started to speak. If a reply is arriving or playing, it stops. */
  callerStartedSpeaking(): void {
    if (this.status === "idle" || this.status === "ended") return;
    this.stopReply(true);
    this.setStatus("hearing");
  }

  /** A sound that turned out not to be a turn. */
  callerWentQuiet(): void {
    if (this.status === "hearing") this.setStatus("listening");
  }

  /** Hang up. The state stays readable. */
  end(): void {
    if (this.status === "ended") return;
    this.stopReply(false);
    if (this.settle) clearTimeout(this.settle);
    this.setStatus("ended");
  }

  private setStatus(status: CallStatus): void {
    this.status = status;
    this.changed();
  }

  private changed(): void {
    this.options.onChange(this.state);
  }

  /** Stops the reply being received or played, if there is one. */
  private stopReply(byCaller: boolean): void {
    const active = this.active;
    if (!active) {
      // Nothing arriving, but the last reply may still be playing out.
      if (this.options.audio.playing) this.options.audio.stop();
      return;
    }
    this.active = null;
    active.controller.abort();
    active.playedMs = this.options.audio.stop();
    if (byCaller) {
      active.interrupted = true;
      active.view.interrupted = true;
      active.view.pending = false;
      // A reply usually finishes arriving long before it finishes playing. If
      // it is already in the history, say there how much of it was heard.
      if (active.remembered) active.remembered.text += interruptionNote(active.playedMs);
    }
  }

  private async exchange(wav: Uint8Array | null, quietMs: number): Promise<void> {
    this.stopReply(false);
    if (this.settle) clearTimeout(this.settle);

    const asked = [...this.history].reverse().find((turn) => turn.role === "assistant")?.text ?? null;
    const userView: CallTurnView | null = wav ? { role: "user", text: "", pending: true } : null;
    const view: CallTurnView = { role: "assistant", text: "", pending: true };
    if (userView) this.turns.push(userView);
    this.turns.push(view);
    const active: ActiveReply = { controller: new AbortController(), view, interrupted: false, playedMs: 0 };
    this.active = active;
    const sentAt = this.now();
    if (this.status !== "connecting") this.setStatus("thinking");
    else this.changed();

    let heard: string | null = null;
    let noise = false;
    let gapCounted = false;
    const emit = (event: VoiceEvent) => {
      if (event.type === "audio") {
        if (this.active !== active) return; // interrupted: drop what is still arriving
        const startsInMs = this.options.audio.play(base64ToBytes(event.data));
        if (this.status !== "speaking") {
          if (userView) {
            const stoppedToReplyMs = Math.round(quietMs + (this.now() - sentAt) + startsInMs);
            view.timing = { stoppedToReplyMs, waitedMs: Math.round(quietMs) };
            this.gaps.push(stoppedToReplyMs);
            gapCounted = true;
          }
          this.setStatus("speaking");
        }
      } else if (event.type === "said") {
        view.text += event.text;
        this.changed();
      } else if (event.type === "heard") {
        if (!userView) return;
        heard = event.text;
        userView.text = event.text ?? "Could not transcribe that";
        userView.pending = false;
        if (event.text === null) userView.error = event.error ?? "not transcribed";
        this.changed();
        if (event.text) void this.takeNotes(asked, event.text);
      } else if (event.type === "noise") {
        // Not a turn. Take it back, and stop the reply to it if one had started.
        noise = true;
        if (this.active === active) this.stopReply(false);
        for (const taken of [userView, view]) {
          const at = taken ? this.turns.indexOf(taken) : -1;
          if (at >= 0) this.turns.splice(at, 1);
        }
        if (gapCounted) this.gaps.pop();
        this.changed();
      } else if (event.type === "error") {
        view.error = event.message;
        this.changed();
      }
    };

    await runVoiceTurn({
      upstream: this.options.upstream,
      models: this.options.models,
      input: {
        assistantName: this.options.assistantName,
        items: this.options.items,
        decisions: { ...this.decisions },
        history: [...this.history],
        audio: wav ?? undefined,
        voice: this.options.voice,
      },
      emit,
      signal: active.controller.signal,
    });

    if (noise) {
      // The reply was stopped when the noise was found, so nothing is playing out.
      if (this.status === "thinking" || this.status === "speaking" || this.status === "connecting") this.setStatus("listening");
      return;
    }
    view.pending = false;
    if (userView && userView.pending) {
      // The transcript never came back.
      userView.pending = false;
      userView.text = "Could not transcribe that";
    }
    if (userView) this.history.push({ role: "user", text: heard ?? UNTRANSCRIBED });
    if (view.text) {
      active.remembered = { role: "assistant", text: `${view.text}${active.interrupted ? interruptionNote(active.playedMs) : ""}` };
      this.history.push(active.remembered);
    }
    this.changed();
    this.afterReply(active);
  }

  /** The audio usually arrives well before it has finished playing. Stay "speaking" until it has. */
  private afterReply(active: ActiveReply): void {
    const wait = () => {
      if (this.active !== active) return; // interrupted or superseded
      if (this.options.audio.playing) {
        this.settle = setTimeout(wait, 50);
        return;
      }
      this.active = null;
      if (this.status === "speaking" || this.status === "thinking" || this.status === "connecting") this.setStatus("listening");
    };
    wait();
  }

  /** Records which items the caller's words decided. Runs apart from the reply. */
  private async takeNotes(asked: string | null, said: string): Promise<void> {
    try {
      const notes = await takeVoiceNotes(this.options.upstream, this.options.models.notes, {
        items: this.options.items,
        alreadyRecorded: Object.keys(this.decisions),
        assistantAsked: asked,
        callerSaid: said,
      });
      for (const entry of notes.decisions) {
        const decision: CallDecision = { decision: entry.decision, quote: entry.quote };
        this.decisions[entry.item] = decision;
        if (this.options.onDecision) {
          try {
            await this.options.onDecision(entry.item, decision);
          } catch {
            // The decision stays on the call; saving it is retried by whoever applies the call.
          }
        }
      }
      if (notes.currentItem) this.currentItem = notes.currentItem;
      this.changed();
    } catch {
      // A turn without notes is still a turn: the transcript has what was said.
    }
  }
}

/**
 * The record of a call, as a message for the AI user who will act on it.
 * Plain text: decisions first, then anything left open, then the transcript.
 */
export function callRecordMessage(args: { items: CallItem[]; state: CallState; sheetTitle?: string }): string {
  const { items, state } = args;
  const decided = items.filter((item) => state.decisions[item.id]);
  const open = items.filter((item) => !state.decisions[item.id]);
  const lines: string[] = [];
  lines.push(`Voice call record${args.sheetTitle ? ` for "${args.sheetTitle}"` : ""}: ${decided.length} of ${items.length} items answered.`);
  lines.push("Please apply each answer where it belongs, then say what you changed. My words below are a transcript and may contain small errors.");
  if (decided.length) {
    lines.push("", "Answered:");
    decided.forEach((item, index) => {
      const d = state.decisions[item.id];
      lines.push(`${index + 1}. ${item.title}: ${d.decision}${d.quote ? ` (I said: "${d.quote}")` : ""}${item.source ? ` [${item.source}]` : ""}`);
    });
  }
  if (open.length) {
    lines.push("", "Not answered:");
    for (const item of open) lines.push(`- ${item.title}${item.source ? ` [${item.source}]` : ""}`);
  }
  const spoken = state.turns.filter((turn) => turn.text && !turn.error);
  if (spoken.length) {
    lines.push("", "Transcript:");
    for (const turn of spoken) lines.push(`${turn.role === "user" ? "Me" : "You"}: ${turn.text}${turn.interrupted ? " (interrupted)" : ""}`);
  }
  return lines.join("\n");
}
