import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  createSilenceTracker,
  runVoiceTurn,
  takeVoiceNotes,
  talkerSystemPrompt,
} from "./index";
import type { VoiceEvent, VoiceUpstream } from "./index";
import { ITEMS, MODELS, fakeUpstream, pcm, sleep, wav } from "./fixtures";

async function turn(fake: ReturnType<typeof fakeUpstream>, input: Partial<Parameters<typeof runVoiceTurn>[0]["input"]> = {}, signal?: AbortSignal) {
  const events: VoiceEvent[] = [];
  const result = await runVoiceTurn({
    upstream: fake.upstream,
    models: MODELS,
    input: { items: ITEMS, decisions: {}, history: [], voice: "alloy", ...input },
    emit: (event) => events.push(event),
    signal,
    transcriptGraceMs: 500,
  });
  const audio = events.filter((e): e is Extract<VoiceEvent, { type: "audio" }> => e.type === "audio").map((e) => base64ToBytes(e.data));
  return { events, result, audio, audioBytes: audio.reduce((n, chunk) => n + chunk.length, 0), types: events.map((e) => e.type) };
}

const SPEECH_BYTES = 600 * 48; // 0.6 s at 24 kHz, 16-bit

describe("silence tracker", () => {
  it("tells speech from the silence a reply trails off into", () => {
    const tracker = createSilenceTracker();
    expect(tracker.push(pcm(300, 20))).toBe(false);
    expect(tracker.heardSpeech).toBe(false);
    expect(tracker.trailingSilenceMs).toBe(0); // silence before any speech does not count
    expect(tracker.push(pcm(400, 6000))).toBe(true);
    expect(tracker.speechMs).toBe(700);
    expect(tracker.push(pcm(1200, 20))).toBe(false);
    expect(tracker.trailingSilenceMs).toBe(1200);
    expect(tracker.push(pcm(100, 6000))).toBe(true);
    expect(tracker.trailingSilenceMs).toBe(0);
  });

  it("handles chunks that do not line up with its windows", () => {
    const tracker = createSilenceTracker();
    const speech = pcm(250, 6000);
    expect(tracker.push(speech.subarray(0, 1001))).toBe(false); // under one window so far
    expect(tracker.push(speech.subarray(1001))).toBe(true);
    expect(tracker.speechMs).toBe(200);
  });
});

describe("a spoken turn", () => {
  it("opens the call from the sheet, passing on speech and holding back trailing silence", async () => {
    const fake = fakeUpstream();
    const { result, audio, audioBytes, types } = await turn(fake);
    expect(result.said).toBe("Noting that. Next is the following item.");
    expect(audioBytes).toBe(SPEECH_BYTES);
    expect(audio.every((chunk) => chunk.length % 2 === 0)).toBe(true);
    expect(result.timing).toMatchObject({ speechMs: 600, cutForSilence: false });
    expect(types.at(-1)).toBe("done");
    expect(result.heard).toBeNull();
    const sent = fake.seen.talker[0] as { messages: Array<{ role: string; content: unknown }>; audio: unknown; max_tokens: number; usage: unknown };
    expect(sent.messages.at(-1)?.content).toContain("say there are 2 items today");
    expect(sent.messages[0].content).toContain("There are 2 open items, in order:");
    expect(sent.audio).toEqual({ voice: "alloy", format: "pcm16" });
    expect(sent.max_tokens).toBe(500);
    expect(sent.usage).toEqual({ include: true });
    expect(fake.seen.transcriptions).toHaveLength(0);
  });

  it("stops a reply that trails off into silence, and passes none of the silence on", async () => {
    const fake = fakeUpstream({ silentPieces: 32 }); // 8 s of near-silence
    const { result, audioBytes } = await turn(fake);
    expect(audioBytes).toBe(SPEECH_BYTES);
    expect(result.timing?.cutForSilence).toBe(true);
    expect(fake.seen.talkerAborted).toBe(true);
  });

  it("keeps a pause inside the reply", async () => {
    // Silence followed by more speech is a pause: it is passed on once the speech arrives.
    const tracker = createSilenceTracker();
    expect(tracker.push(pcm(200, 6000))).toBe(true);
    expect(tracker.push(pcm(1400, 20))).toBe(false);
    expect(tracker.push(pcm(200, 6000))).toBe(true);
    expect(tracker.speechMs).toBe(1800);
  });

  it("sends the caller's turn as audio and earlier turns as text, and reports what was heard", async () => {
    const fake = fakeUpstream();
    const history = [{ role: "assistant" as const, text: "Is the first thing done?" }];
    const { result, events, types } = await turn(fake, { audio: wav(), history, assistantName: "Kira" });
    expect(result.heard).toBe("Yes, go ahead with that.");
    expect(events).toContainEqual({ type: "heard", text: "Yes, go ahead with that." });
    expect(types).not.toContain("noise");
    const sent = fake.seen.talker[0] as { messages: Array<{ role: string; content: unknown }> };
    expect(sent.messages[0].content).toMatch(/^You are Kira, an assistant on a voice call/);
    expect(sent.messages.slice(1, -1)).toEqual([{ role: "assistant", content: "Is the first thing done?" }]);
    const last = sent.messages.at(-1)?.content as Array<{ type: string; input_audio: { data: string; format: string } }>;
    expect(last[0].type).toBe("input_audio");
    expect(last[0].input_audio.format).toBe("wav");
    expect(base64ToBytes(last[0].input_audio.data)).toHaveLength(wav().length);
  });

  it("voids a capture with no words in it and stops the reply", async () => {
    const fake = fakeUpstream({ speechMs: 3000, pieceDelayMs: 10 });
    const { result, types, audioBytes } = await turn(fake, { audio: wav(0.2), history: [{ role: "assistant", text: "Is the first thing done?" }] });
    expect(result.noise).toBe(true);
    expect(types).toContain("noise");
    expect(types).not.toContain("done");
    expect(types).not.toContain("error");
    expect(audioBytes).toBeLessThan(3000 * 48);
    expect(fake.seen.talkerAborted).toBe(true);
  });

  it("still replies when transcription fails", async () => {
    const fake = fakeUpstream({ transcriptionFails: true });
    const { result, events, audioBytes } = await turn(fake, { audio: wav(), history: [{ role: "assistant", text: "Is the first thing done?" }] });
    expect(audioBytes).toBe(SPEECH_BYTES);
    expect(result.heard).toBeNull();
    const heard = events.find((e) => e.type === "heard") as Extract<VoiceEvent, { type: "heard" }>;
    expect(heard.text).toBeNull();
    expect(heard.error).toContain("HTTP 503");
  });

  it("reports an upstream failure without the key", async () => {
    const fake = fakeUpstream({ talkerStatus: 404 });
    const { result, events } = await turn(fake);
    expect(result.error).toContain("HTTP 404");
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(JSON.stringify(events)).not.toContain("secret-key");
  });

  it("stops quietly when the caller interrupts", async () => {
    const fake = fakeUpstream({ speechMs: 3000, pieceDelayMs: 10 });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 60);
    const { types, audioBytes } = await turn(fake, {}, abort.signal);
    expect(types).not.toContain("error");
    expect(audioBytes).toBeGreaterThan(0);
    expect(audioBytes).toBeLessThan(3000 * 48);
    expect(fake.seen.talkerAborted).toBe(true);
  });

  it("uses OpenAI's field names when the upstream is not OpenRouter", async () => {
    const fake = fakeUpstream({ baseUrl: "https://api.openai.com/v1" });
    const { result } = await turn(fake, { audio: wav(), history: [{ role: "assistant", text: "Is the first thing done?" }] });
    expect(result.heard).toBe("Yes, go ahead with that.");
    const sent = fake.seen.talker[0] as Record<string, unknown>;
    expect(sent.max_completion_tokens).toBe(500);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(sent.max_tokens).toBeUndefined();
    expect(sent.usage).toBeUndefined();
    expect(fake.seen.transcriptions[0].contentType).not.toBe("application/json"); // a multipart upload
  });
});

describe("a call through a host that attaches the key", () => {
  it("sends the three requests to the host's paths, with no key and in the host's dialect", async () => {
    const calls: Array<{ url: string; auth: string | null; contentType: string | null; body: Record<string, unknown> }> = [];
    const inner = fakeUpstream();
    const hostFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), auth: headers.get("authorization"), contentType: headers.get("content-type"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      // The stand-in answers by path suffix, so map the host's paths back.
      const path = String(input).endsWith("/transcribe") ? "/audio/transcriptions" : "/chat/completions";
      return inner.upstream.fetch!(`https://openrouter.ai/api/v1${path}`, init);
    }) as typeof fetch;
    const upstream: VoiceUpstream = { baseUrl: "/api/workspaces/acme/ai-users/7/voice/", dialect: "openrouter", paths: { talk: "/talk", transcribe: "/transcribe", notes: "/notes" }, fetch: hostFetch };

    const events: VoiceEvent[] = [];
    const result = await runVoiceTurn({ upstream, models: MODELS, input: { items: ITEMS, decisions: {}, history: [{ role: "assistant", text: "Is the first thing done?" }], audio: wav(), voice: "alloy" }, emit: (e) => events.push(e), transcriptGraceMs: 500 });
    expect(result.heard).toBe("Yes, go ahead with that.");
    await takeVoiceNotes(upstream, MODELS.notes, { items: ITEMS, alreadyRecorded: [], assistantAsked: "Is the first thing done?", callerSaid: "Yes." });

    expect(calls.map((c) => c.url).sort()).toEqual([
      "/api/workspaces/acme/ai-users/7/voice/notes",
      "/api/workspaces/acme/ai-users/7/voice/talk",
      "/api/workspaces/acme/ai-users/7/voice/transcribe",
    ]);
    expect(calls.every((c) => c.auth === null)).toBe(true);
    expect(calls.every((c) => c.contentType === "application/json")).toBe(true);
    const talk = calls.find((c) => c.url.endsWith("/talk"))!;
    expect(talk.body.max_tokens).toBe(500); // OpenRouter's field names, although the base URL is not OpenRouter's
    expect(talk.body.usage).toEqual({ include: true });
  });
});

describe("the talker's instructions", () => {
  it("moves a decided item out of the open list", () => {
    const prompt = talkerSystemPrompt({ items: ITEMS, decisions: { A: { decision: "Yes, it is done." } } });
    expect(prompt).toContain("There are 1 open items, in order:");
    expect(prompt).not.toContain("Item A.");
    expect(prompt).toContain("Already decided on this call, do not raise again:\n- First thing: Yes, it is done.");
  });
});

describe("notes", () => {
  const input = { items: ITEMS, alreadyRecorded: [], assistantAsked: "Is the first thing done?", callerSaid: "Yes, go ahead with that." };

  it("finds the JSON, keeps only items on the sheet, and falls back to the caller's words for the quote", async () => {
    const fake = fakeUpstream({ notesContent: 'Sure.\n```json\n{"decisions":[{"item":"A","decision":" Yes to the first thing. "},{"item":"Z","decision":"Not on the sheet"},{"item":"B","decision":""}],"current_item":"Q"}\n```' });
    const notes = await takeVoiceNotes(fake.upstream, MODELS.notes, input);
    expect(notes.decisions).toEqual([{ item: "A", decision: "Yes to the first thing.", quote: "Yes, go ahead with that." }]);
    expect(notes.currentItem).toBeNull();
    const sent = fake.seen.notes[0] as { reasoning: unknown; messages: Array<{ content: string }> };
    expect(sent.reasoning).toEqual({ effort: "none" });
    expect(JSON.parse(sent.messages[1].content).exchange).toEqual({ assistant_asked: "Is the first thing done?", caller_said: "Yes, go ahead with that.", assistant_replied: null });
  });

  it("fails when the model does not return JSON", async () => {
    const fake = fakeUpstream({ notesContent: "I could not tell." });
    await expect(takeVoiceNotes(fake.upstream, MODELS.notes, input)).rejects.toThrow("notes were not JSON");
  });
});
