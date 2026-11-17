import { base64ToBytes, bytesToBase64 } from "./audio";
import type { CallItem, VoiceModels, VoiceUpstream } from "./types";

/** Shared by the voice tests: a call sheet, clips, and a stand-in for the three upstream calls. */

export const MODELS: VoiceModels = { talker: "test/talker", transcribe: "test/transcribe", notes: "test/notes" };
export const ITEMS: CallItem[] = [
  { id: "A", title: "First thing", say: "Is the first thing done?", recommendation: "No recommendation.", detail: "Detail of the first thing." },
  { id: "B", title: "Second thing", say: "Shall we do the second thing?", recommendation: "Yes.", detail: "Detail of the second thing." },
];
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 24 kHz mono 16-bit PCM of the given length, as a square wave of the given amplitude. */
export function pcm(ms: number, amplitude: number): Uint8Array {
  const samples = (24_000 * ms) / 1000;
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i += 1) view.setInt16(i * 2, i % 2 ? amplitude : -amplitude, true);
  return out;
}

/** A clip of the given length. The fake transcriber finds no words in one under about a third of a second. */
export function wav(seconds = 1): Uint8Array {
  return new Uint8Array(44 + Math.round(16_000 * seconds) * 2).fill(7);
}

export interface FakeOptions {
  baseUrl?: string;
  speechMs?: number;
  /** Trailing near-silence after the speech, in 250 ms pieces. */
  silentPieces?: number;
  talkerStatus?: number;
  transcriptionFails?: boolean;
  notesContent?: string;
  /** Delay between stream pieces, so a test can act mid-stream. */
  pieceDelayMs?: number;
}

/** Stands in for the three upstream calls and remembers what it was sent. */
export function fakeUpstream(options: FakeOptions = {}) {
  const seen = { talker: [] as Array<Record<string, unknown>>, notes: [] as Array<Record<string, unknown>>, transcriptions: [] as Array<{ contentType: string | null }>, talkerAborted: false };
  const speechPieces = Math.round((options.speechMs ?? 600) / 100);
  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url.endsWith("/audio/transcriptions")) {
      seen.transcriptions.push({ contentType: headers.get("content-type") });
      await sleep(5);
      if (options.transcriptionFails) return new Response(JSON.stringify({ error: { message: "transcriber is down" } }), { status: 503 });
      let bytes = 20_000;
      if (typeof init?.body === "string") bytes = base64ToBytes((JSON.parse(init.body) as { input_audio: { data: string } }).input_audio.data).length;
      return Response.json({ text: bytes < 10_000 ? "" : " Yes, go ahead with that. " });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (!Array.isArray(body.modalities)) {
      seen.notes.push(body);
      return Response.json({ choices: [{ message: { content: options.notesContent ?? `Here is the record:\n{"decisions":[{"item":"A","decision":"Yes to the first thing."}],"current_item":"B"}` } }], usage: { cost: 0.0002 } });
    }
    seen.talker.push(body);
    if (options.talkerStatus) return new Response(JSON.stringify({ error: { message: "No endpoints found" } }), { status: options.talkerStatus });
    const encoder = new TextEncoder();
    const signal = init?.signal;
    const pieces: string[] = [];
    const event = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
    pieces.push(": PROCESSING\n\n", event({ audio: { transcript: "Noting that." } }));
    for (let i = 0; i < speechPieces; i += 1) {
      const chunk = pcm(100, 6000);
      // The first two chunks split a sample between them, to check that samples are kept whole.
      const bytes = i === 0 ? chunk.subarray(0, chunk.length - 1) : i === 1 ? new Uint8Array([chunk[chunk.length - 1], ...chunk]) : chunk;
      pieces.push(event({ audio: { data: bytesToBase64(bytes) } }));
    }
    pieces.push(event({ audio: { transcript: " Next is the following item." } }));
    for (let i = 0; i < (options.silentPieces ?? 2); i += 1) pieces.push(event({ audio: { data: bytesToBase64(pcm(250, 20)) } }));
    pieces.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 180, cost: 0.0007 } })}\n\n`, "data: [DONE]\n\n");
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted) {
          seen.talkerAborted = true;
          controller.error(new DOMException("aborted", "AbortError"));
          return;
        }
        if (index >= pieces.length) {
          controller.close();
          return;
        }
        await sleep(options.pieceDelayMs ?? 1);
        // Split each piece across two reads, to exercise the line buffer.
        const piece = pieces[index];
        index += 1;
        controller.enqueue(encoder.encode(piece.slice(0, 9)));
        controller.enqueue(encoder.encode(piece.slice(9)));
      },
      cancel() {
        seen.talkerAborted = true;
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const upstream: VoiceUpstream = { baseUrl: options.baseUrl ?? "https://openrouter.ai/api/v1", apiKey: "secret-key", fetch: fetchFake };
  return { upstream, seen };
}
