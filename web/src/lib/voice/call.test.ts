import { describe, expect, it } from "vitest";
import { VoiceCall, callRecordMessage, type CallAudioOut, type CallState } from "./call";
import { blockRms, createTurnDetector, encodeWav, pcm16ToFloat32, UPLOAD_SAMPLE_RATE } from "./capture";
import { ITEMS, MODELS, fakeUpstream, pcm, sleep, wav } from "./fixtures";
import { decisionWrites, isCallSheet, readCallSheet, type SheetDefinition, type SheetRow, type SheetValue } from "./sheet";
import type { CallDecision } from "./types";

/** Playback that plays nothing and reports what it was asked to do. With `holds`, queued audio keeps "playing" until the test says it has finished. */
function fakeAudio(holds = false) {
  const out = { bytes: 0, stops: 0, playing: false, startsInMs: 20, playedMs: 1900 };
  const audio: CallAudioOut = {
    play(chunk) {
      out.bytes += chunk.length;
      if (holds) out.playing = true;
      return out.startsInMs;
    },
    stop() {
      out.stops += 1;
      out.playing = false;
      return out.playedMs;
    },
    get playing() {
      return out.playing;
    },
  };
  return { audio, out };
}

function call(fake: ReturnType<typeof fakeUpstream>, extra: Partial<ConstructorParameters<typeof VoiceCall>[0]> = {}) {
  const states: CallState[] = [];
  const saved: Array<[string, CallDecision]> = [];
  const { audio, out } = fakeAudio();
  const session = new VoiceCall({
    upstream: fake.upstream,
    models: MODELS,
    voice: "alloy",
    assistantName: "Kira",
    items: ITEMS,
    audio,
    onChange: (state) => states.push(state),
    onDecision: (id, decision) => { saved.push([id, decision]); },
    ...extra,
  });
  return { session, states, saved, audioOut: out };
}

const until = async (check: () => boolean, label: string) => {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
};

describe("a voice call", () => {
  it("opens, takes a spoken answer, records the decision and reports how long the caller waited", async () => {
    const fake = fakeUpstream();
    let clock = 1000;
    const { session, states, saved, audioOut } = call(fake, { now: () => (clock += 100) });

    await session.start();
    expect(session.state.status).toBe("listening");
    expect(states.map((s) => s.status)).toContain("connecting");
    expect(states.map((s) => s.status)).toContain("speaking");
    expect(session.state.turns).toEqual([{ role: "assistant", text: "Noting that. Next is the following item.", pending: false }]);
    expect(audioOut.bytes).toBe(600 * 48);

    session.callerStartedSpeaking();
    expect(session.state.status).toBe("hearing");
    await session.submit(wav(), 700);
    await until(() => Object.keys(session.state.decisions).length === 1, "the decision");

    const state = session.state;
    expect(state.status).toBe("listening");
    expect(state.turns.map((t) => [t.role, t.text, t.pending])).toEqual([
      ["assistant", "Noting that. Next is the following item.", false],
      ["user", "Yes, go ahead with that.", false],
      ["assistant", "Noting that. Next is the following item.", false],
    ]);
    // 700 ms of waiting to be sure they had stopped, the time to the first audio, and 20 ms until it plays.
    expect(state.turns[2].timing?.waitedMs).toBe(700);
    expect(state.turns[2].timing?.stoppedToReplyMs).toBeGreaterThanOrEqual(820);
    expect(state.gapsMs).toEqual([state.turns[2].timing?.stoppedToReplyMs]);
    expect(state.decisions.A).toEqual({ decision: "Yes to the first thing.", quote: "Yes, go ahead with that." });
    expect(state.currentItem).toBe("B");
    expect(saved).toEqual([["A", { decision: "Yes to the first thing.", quote: "Yes, go ahead with that." }]]);

    // The second request carried the opening as text and named the assistant.
    const sent = fake.seen.talker[1] as { messages: Array<{ role: string; content: unknown }> };
    expect(sent.messages[0].content).toMatch(/^You are Kira, an assistant/);
    expect(sent.messages.slice(1, -1)).toEqual([{ role: "assistant", content: "Noting that. Next is the following item." }]);
    // The notes were asked what the answer was to.
    const notes = JSON.parse((fake.seen.notes[0] as { messages: Array<{ content: string }> }).messages[1].content) as { exchange: unknown; already_recorded: string[] };
    expect(notes.exchange).toEqual({ assistant_asked: "Noting that. Next is the following item.", caller_said: "Yes, go ahead with that.", assistant_replied: null });
  });

  it("tells the talker what is already decided when a call is resumed", async () => {
    const fake = fakeUpstream();
    const { session } = call(fake, { decisions: { A: { decision: "Done last time." } } });
    await session.start();
    const sent = fake.seen.talker[0] as { messages: Array<{ content: string }> };
    expect(sent.messages[0].content).toContain("There are 1 open items, in order:");
    expect(sent.messages[0].content).toContain("- First thing: Done last time.");
  });

  it("drops a capture with no words in it: no turn, no reply kept, no notes", async () => {
    const fake = fakeUpstream({ speechMs: 2000, pieceDelayMs: 5 });
    const { session, audioOut } = call(fake);
    await session.start();
    const before = session.state.turns.length;
    await session.submit(wav(0.2), 700);
    expect(session.state.turns).toHaveLength(before);
    expect(session.state.gapsMs).toEqual([]);
    expect(fake.seen.notes).toHaveLength(0);
    expect(audioOut.stops).toBeGreaterThan(0);
    expect(session.state.status).toBe("listening");
    // The next real turn does not carry the noise in its history.
    await session.submit(wav(), 700);
    const sent = fake.seen.talker.at(-1) as { messages: Array<{ role: string }> };
    expect(sent.messages.slice(1, -1).map((m) => m.role)).toEqual(["assistant"]);
  });

  it("stops a reply when the caller talks over it, and tells the talker how much they heard", async () => {
    const fake = fakeUpstream({ speechMs: 3000, pieceDelayMs: 10 });
    const { session, audioOut } = call(fake);
    const opening = session.start();
    await until(() => session.state.status === "speaking", "the reply to start");
    session.callerStartedSpeaking();
    await opening;
    expect(audioOut.stops).toBe(1);
    expect(session.state.turns[0]).toMatchObject({ role: "assistant", interrupted: true, pending: false });
    expect(session.state.status).toBe("hearing");

    await session.submit(wav(), 700);
    const sent = fake.seen.talker.at(-1) as { messages: Array<{ role: string; content: string }> };
    expect(sent.messages[1].content).toMatch(/\(the caller interrupted after about 2 seconds of this\)$/);
  });

  it("tells the talker when a reply that had fully arrived was talked over while it played", async () => {
    const fake = fakeUpstream();
    const { audio, out } = fakeAudio(true);
    const session = new VoiceCall({ upstream: fake.upstream, models: MODELS, voice: "alloy", items: ITEMS, audio, onChange: () => undefined });
    await session.start(); // the whole reply has arrived and is still playing
    expect(session.state.status).toBe("speaking");
    session.callerStartedSpeaking();
    expect(out.stops).toBe(1);
    expect(session.state.turns[0]).toMatchObject({ interrupted: true });
    await session.submit(wav(), 700);
    const sent = fake.seen.talker.at(-1) as { messages: Array<{ role: string; content: string }> };
    expect(sent.messages[1].content).toBe("Noting that. Next is the following item. (the caller interrupted after about 2 seconds of this)");
  });

  it("stays speaking until playback has finished", async () => {
    const fake = fakeUpstream();
    const states: CallState[] = [];
    const { audio, out } = fakeAudio(true);
    const session = new VoiceCall({ upstream: fake.upstream, models: MODELS, voice: "alloy", items: ITEMS, audio, onChange: (s) => states.push(s) });
    await session.start();
    expect(session.state.status).toBe("speaking");
    out.playing = false;
    await until(() => session.state.status === "listening", "playback to end");
  });

  it("keeps the call going when a reply fails, and shows the failure on the turn", async () => {
    const fake = fakeUpstream({ talkerStatus: 402 });
    const { session } = call(fake);
    await session.start();
    expect(session.state.turns[0].error).toContain("HTTP 402");
    expect(session.state.status).toBe("listening");
  });

  it("ends, and nothing more happens after that", async () => {
    const fake = fakeUpstream();
    const { session } = call(fake);
    await session.start();
    session.end();
    expect(session.state.status).toBe("ended");
    await session.submit(wav(), 700);
    expect(fake.seen.talker).toHaveLength(1);
  });

  it("writes the record of the call for the AI user", () => {
    const state: CallState = {
      status: "ended",
      turns: [
        { role: "assistant", text: "Is the first thing done?", pending: false },
        { role: "user", text: "Yes it is.", pending: false },
        { role: "assistant", text: "Noting that. Shall we", pending: false, interrupted: true },
        { role: "assistant", text: "", pending: false, error: "HTTP 502" },
      ],
      decisions: { A: { decision: "The first thing is done.", quote: "Yes it is." } },
      currentItem: "B",
      gapsMs: [1700],
    };
    const items = [{ ...ITEMS[0], source: "ask 12" }, ITEMS[1]];
    expect(callRecordMessage({ items, state, sheetTitle: "Standup" })).toBe(
      [
        'Voice call record for "Standup": 1 of 2 items answered.',
        "Please apply each answer where it belongs, then say what you changed. My words below are a transcript and may contain small errors.",
        "",
        "Answered:",
        '1. First thing: The first thing is done. (I said: "Yes it is.") [ask 12]',
        "",
        "Not answered:",
        "- Second thing",
        "",
        "Transcript:",
        "You: Is the first thing done?",
        "Me: Yes it is.",
        "You: Noting that. Shall we (interrupted)",
      ].join("\n"),
    );
  });
});

describe("a call sheet in a Pear database", () => {
  const text = { tag: "Text" };
  const definitions: SheetDefinition[] = [
    { id: 1n, schemaId: 9n, name: "say", propertyType: text },
    { id: 2n, schemaId: 9n, name: "Recommendation", propertyType: text },
    { id: 3n, schemaId: 9n, name: " Detail ", propertyType: text },
    { id: 4n, schemaId: 9n, name: "Source", propertyType: text },
    { id: 5n, schemaId: 9n, name: "Decision", propertyType: text },
    { id: 6n, schemaId: 9n, name: "Quote", propertyType: text },
    { id: 7n, schemaId: 9n, name: "Priority", propertyType: { tag: "Select" } },
  ];
  const rows: SheetRow[] = [
    { id: 20n, title: "Second", sortOrder: 2 },
    { id: 10n, title: "First", sortOrder: 1 },
    { id: 30n, title: "Deleted", sortOrder: 0, deletedAt: {} },
    { id: 40n, title: "Nothing to ask", sortOrder: 3 },
    { id: 50n, title: "  ", sortOrder: 4 },
  ];
  const value = (pageId: bigint, def: bigint, v: string): SheetValue => ({ pageId, propertyDefinitionId: def, value: { tag: "Text", value: v } });
  const values: SheetValue[] = [
    value(10n, 1n, "Is the first thing done?"), value(10n, 2n, "Say yes."), value(10n, 3n, "Background."), value(10n, 4n, "ask 12"),
    value(20n, 1n, "And the second?"), value(20n, 5n, "Parked."), value(20n, 6n, "Later."),
    value(30n, 1n, "Deleted row."), value(50n, 1n, "Untitled row."),
    { pageId: 10n, propertyDefinitionId: 7n, value: { tag: "Select", value: "High" } },
  ];

  it("reads rows in order as items, and existing decisions as already decided", () => {
    const sheet = readCallSheet({ definitions, rows, values });
    expect(sheet.items).toEqual([
      { id: "r10", title: "First", say: "Is the first thing done?", recommendation: "Say yes.", detail: "Background.", source: "ask 12" },
      { id: "r20", title: "Second", say: "And the second?", recommendation: "No recommendation.", detail: "" },
    ]);
    expect(sheet.decisions).toEqual({ r20: { decision: "Parked.", quote: "Later." } });
    expect(sheet.rowIds).toEqual({ r10: 10n, r20: 20n });
  });

  it("is any database with a text column named Say", () => {
    expect(isCallSheet(definitions)).toBe(true);
    expect(isCallSheet(definitions.filter((d) => d.id !== 1n))).toBe(false);
    expect(isCallSheet([{ id: 1n, schemaId: 9n, name: "Say", propertyType: { tag: "Select" } }])).toBe(false);
  });

  it("writes a decision and the caller's words back to the row", () => {
    const sheet = readCallSheet({ definitions, rows, values });
    expect(decisionWrites(sheet, "r10", { decision: "Done.", quote: "Yes it is." })).toEqual([
      { pageId: 10n, propertyDefinitionId: 5n, value: { tag: "Text", value: "Done." } },
      { pageId: 10n, propertyDefinitionId: 6n, value: { tag: "Text", value: "Yes it is." } },
    ]);
    expect(decisionWrites(sheet, "r99", { decision: "Done." })).toEqual([]);
    const noDecisionColumn = readCallSheet({ definitions: definitions.filter((d) => d.id !== 5n), rows, values });
    expect(decisionWrites(noDecisionColumn, "r10", { decision: "Done." })).toEqual([]);
  });
});

describe("turn detection", () => {
  const RATE = 48_000;
  const BLOCK = 960; // 20 ms
  const block = (amplitude: number) => new Float32Array(BLOCK).fill(amplitude);
  const quiet = { assistantAudible: false, allowInterrupt: true };

  function feed(detector: ReturnType<typeof createTurnDetector>, amplitude: number, ms: number, context = quiet) {
    const events = [];
    for (let i = 0; i < ms / 20; i += 1) {
      const event = detector.push(block(amplitude), context);
      if (event) events.push(event);
    }
    return events;
  }

  it("takes a turn from the first sound to a pause, with a little audio from before it", () => {
    const detector = createTurnDetector(RATE, { endpointMs: 700 });
    expect(feed(detector, 0.002, 1000)).toEqual([]);
    expect(feed(detector, 0.2, 200).map((e) => e.type)).toEqual(["speech-start"]);
    expect(detector.capturing).toBe(true);
    expect(feed(detector, 0.2, 1000)).toEqual([]);
    expect(feed(detector, 0.002, 680)).toEqual([]); // not quiet for long enough yet
    const [turn] = feed(detector, 0.002, 20);
    expect(turn.type).toBe("turn");
    if (turn.type !== "turn") return;
    expect(turn.quietMs).toBe(700);
    expect(turn.speechMs).toBeGreaterThanOrEqual(1100);
    const ms = (turn.blocks.reduce((n, b) => n + b.length, 0) / RATE) * 1000;
    // About 300 ms of pre-roll, 1.2 s of speech and a 150 ms tail.
    expect(ms).toBeGreaterThan(1500);
    expect(ms).toBeLessThan(1800);
    expect(detector.capturing).toBe(false);
  });

  it("does not take a short noise for a turn", () => {
    const detector = createTurnDetector(RATE, { endpointMs: 400 });
    feed(detector, 0.002, 500);
    const events = [...feed(detector, 0.2, 120), ...feed(detector, 0.002, 400)];
    expect(events.map((e) => e.type)).toEqual(["speech-start", "discarded"]);
  });

  it("needs a louder, longer sound to interrupt a reply, and none will if interrupting is off", () => {
    const speaking = { assistantAudible: true, allowInterrupt: true };
    const detector = createTurnDetector(RATE, { endpointMs: 700 });
    feed(detector, 0.002, 500);
    expect(feed(detector, 0.02, 400, speaking)).toEqual([]); // loud enough in a quiet room, not over a reply
    expect(feed(detector, 0.2, 180, speaking)).toEqual([]); // loud, but not for long enough
    expect(feed(detector, 0.2, 40, speaking).map((e) => e.type)).toEqual(["speech-start"]);

    const muted = createTurnDetector(RATE, { endpointMs: 700 });
    expect(feed(muted, 0.5, 1000, { assistantAudible: true, allowInterrupt: false })).toEqual([]);
  });

  it("follows the room: steady background noise stops counting as speech", () => {
    const detector = createTurnDetector(RATE, { endpointMs: 700 });
    // A fan at a level just under the default bar raises the floor without ever starting a turn.
    expect(feed(detector, 0.011, 4000)).toEqual([]);
    // The same room, slightly louder for a moment: still not speech.
    expect(feed(detector, 0.03, 300)).toEqual([]);
    expect(feed(detector, 0.2, 200).map((e) => e.type)).toEqual(["speech-start"]);
  });

  it("cuts a turn off at the limit", () => {
    const detector = createTurnDetector(RATE, { endpointMs: 700, maxTurnMs: 2000 });
    feed(detector, 0.002, 400);
    const events = feed(detector, 0.2, 2400);
    // The caller is still talking, so a new turn starts straight after the cut.
    expect(events.map((e) => e.type)).toEqual(["speech-start", "turn", "speech-start"]);
    const cut = events[1];
    if (cut.type !== "turn") return;
    const ms = (cut.blocks.reduce((n, b) => n + b.length, 0) / RATE) * 1000;
    expect(ms).toBeGreaterThan(1900);
    expect(ms).toBeLessThanOrEqual(2020);
  });

  it("encodes a turn as 16 kHz mono WAV and decodes a reply", () => {
    const tone = new Float32Array(RATE).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / RATE));
    const out = encodeWav([tone.subarray(0, 20_000), tone.subarray(20_000)], RATE);
    const view = new DataView(out.buffer);
    expect(String.fromCharCode(...out.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(UPLOAD_SAMPLE_RATE);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(UPLOAD_SAMPLE_RATE * 2); // one second
    expect(out.length).toBe(44 + UPLOAD_SAMPLE_RATE * 2);
    const samples = pcm16ToFloat32(out.subarray(44));
    expect(blockRms(samples)).toBeGreaterThan(0.3);
    expect(blockRms(samples)).toBeLessThan(0.4);
    expect(pcm16ToFloat32(pcm(100, 16384))[1]).toBeCloseTo(0.5, 3);
  });
});
