"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { useAudioAttachment } from "@/src/components/AudioAttachmentContext";

type AudioProps = {
  storageKey: string;
  transcript: string;
  durationSec: number;
  boot: string;
};

function pickRecorderMimeType(): string {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognition) | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

async function uploadAudioBlob(
  pageId: bigint,
  blob: Blob,
  filename: string,
  contentType: string,
  createAttachment: NonNullable<ReturnType<typeof useAudioAttachment>>["createAttachment"]
): Promise<string | null> {
  const res = await fetch("/api/upload/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pageId: String(pageId),
      filename,
      contentType,
    }),
  });
  if (!res.ok) {
    console.error("[AudioBlock] upload request failed");
    return null;
  }
  const { uploadUrl, storageKey } = (await res.json()) as {
    uploadUrl: string;
    storageKey: string;
  };
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    body: blob,
    headers: { "Content-Type": contentType },
  });
  if (!putRes.ok) {
    console.error("[AudioBlock] upload PUT failed");
    return null;
  }
  createAttachment({
    pageId,
    filename,
    contentType,
    storageKey,
    sizeBytes: BigInt(blob.size),
  });
  return storageKey;
}

function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function patchAudio(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any,
  block: { id: string },
  base: AudioProps,
  patch: Partial<AudioProps>
) {
  editor.updateBlock(block, {
    type: "audio",
    props: { ...base, ...patch },
  } as never);
}

interface AudioBlockViewProps {
  block: {
    id: string;
    props: Record<string, unknown>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any;
}

function AudioBlockView({ block, editor }: AudioBlockViewProps) {
  const ctx = useAudioAttachment();
  const props = block.props as unknown as AudioProps;
  const [isRecording, setIsRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const speechRef = useRef<SpeechRecognition | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveTranscriptRef = useRef("");
  const secondsRef = useRef(0);
  const startRecordingRef = useRef<() => Promise<void>>(async () => {});
  const bootHandledRef = useRef(false);

  useEffect(() => {
    liveTranscriptRef.current = liveTranscript;
  }, [liveTranscript]);
  useEffect(() => {
    secondsRef.current = seconds;
  }, [seconds]);

  const stopSpeech = useCallback(() => {
    const s = speechRef.current;
    if (s) {
      try {
        s.stop();
      } catch {
        /* noop */
      }
      speechRef.current = null;
    }
  }, []);

  const finalizeUpload = useCallback(
    async (blob: Blob, mimeType: string, transcript: string, durationSec: number) => {
      if (!ctx) return;
      setUploading(true);
      setError(null);
      try {
        const ext =
          mimeType.includes("ogg") || mimeType.includes("opus") ? ".ogg" : ".webm";
        const storageKey = await uploadAudioBlob(
          ctx.pageId,
          blob,
          `recording-${Date.now()}${ext}`,
          mimeType || "audio/webm",
          ctx.createAttachment
        );
        if (!storageKey) {
          setError("Upload failed");
          return;
        }
        patchAudio(editor, block, props, {
          storageKey,
          transcript,
          durationSec,
          boot: "",
        });
        setLiveTranscript("");
      } catch (e) {
        console.error("[AudioBlock] finalize", e);
        setError("Could not save recording");
      } finally {
        setUploading(false);
      }
    },
    [block, ctx, editor]
  );

  const stopRecordingInternal = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    stopSpeech();
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      try {
        mr.stop();
      } catch {
        /* noop */
      }
    } else {
      mediaRecorderRef.current = null;
      const st = streamRef.current;
      if (st) {
        st.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setIsRecording(false);
    }
  }, [stopSpeech]);

  const startRecording = useCallback(async () => {
    if (!ctx) {
      setError("Editor context missing");
      return;
    }
    setError(null);
    chunksRef.current = [];
    setLiveTranscript("");
    liveTranscriptRef.current = "";
    setSeconds(0);
    secondsRef.current = 0;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.error("[AudioBlock] getUserMedia", e);
      setError("Microphone access denied");
      return;
    }
    streamRef.current = stream;

    const mimeType = pickRecorderMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch (e) {
      console.error("[AudioBlock] MediaRecorder", e);
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setError("Recording not supported in this browser");
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type: type });
      chunksRef.current = [];
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
      setIsRecording(false);
      void finalizeUpload(
        blob,
        type,
        liveTranscriptRef.current.trim(),
        secondsRef.current
      );
    };

    mediaRecorderRef.current = recorder;
    recorder.start(250);
    setIsRecording(true);
    tickRef.current = setInterval(() => {
      setSeconds((s) => {
        const n = s + 1;
        secondsRef.current = n;
        return n;
      });
    }, 1000);

    const SpeechRec = getSpeechRecognitionCtor();
    if (SpeechRec) {
      const speech = new SpeechRec();
      speech.continuous = true;
      speech.interimResults = true;
      speech.lang = typeof navigator !== "undefined" ? navigator.language : "en-US";
      speech.onresult = (ev: SpeechRecognitionEvent) => {
        let piece = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          piece += ev.results[i][0]?.transcript ?? "";
        }
        if (!piece) return;
        setLiveTranscript((prev) => {
          const next = `${prev}${piece}`.trimStart();
          liveTranscriptRef.current = next;
          return next;
        });
      };
      speech.onerror = () => {
        /* non-fatal */
      };
      try {
        speech.start();
        speechRef.current = speech;
      } catch {
        speechRef.current = null;
      }
    }
  }, [ctx, block, editor, finalizeUpload]);

  startRecordingRef.current = startRecording;

  useLayoutEffect(() => {
    if (props.boot !== "record") return;
    if (bootHandledRef.current) return;
    bootHandledRef.current = true;
    patchAudio(editor, block, props, { boot: "" });
    void startRecordingRef.current();
  }, [block, editor, props.boot]);

  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      stopSpeech();
      const mr = mediaRecorderRef.current;
      if (mr && mr.state !== "inactive") {
        try {
          mr.stop();
        } catch {
          /* noop */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [stopSpeech]);

  async function handleUploadFile(file: File) {
    if (!ctx) return;
    setUploading(true);
    setError(null);
    try {
      const storageKey = await uploadAudioBlob(
        ctx.pageId,
        file,
        file.name || "audio",
        file.type || "audio/webm",
        ctx.createAttachment
      );
      if (!storageKey) {
        setError("Upload failed");
        return;
      }
      patchAudio(editor, block, props, {
        storageKey,
        transcript: props.transcript,
        durationSec: props.durationSec,
        boot: "",
      });
    } catch (e) {
      console.error("[AudioBlock] file upload", e);
      setError("Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const displayTranscript = (props.transcript || liveTranscript).trim();
  const hasAudio = Boolean(props.storageKey);
  const src = hasAudio
    ? `/api/upload/proxy?key=${encodeURIComponent(props.storageKey)}`
    : "";
  const showTranscriptSection = hasAudio || isRecording || Boolean(displayTranscript);

  if (!ctx) {
    return (
      <figure
        contentEditable={false}
        className="my-3 rounded-lg border border-dashed border-amber-300 bg-amber-50/50 p-4 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
      >
        Audio block is unavailable (missing editor context).
      </figure>
    );
  }

  return (
    <figure
      contentEditable={false}
      className="my-3 rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900/40"
    >
      <div className="flex flex-col gap-3 p-4">
        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {uploading && (
          <p className="text-xs text-neutral-500">Uploading…</p>
        )}

        {hasAudio && !isRecording && (
          <audio
            src={src}
            controls
            className="w-full max-h-10"
            preload="metadata"
          />
        )}

        {isRecording && (
          <div className="flex items-center gap-3">
            <span className="inline-flex h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
            <span className="font-mono text-sm tabular-nums text-neutral-700 dark:text-neutral-200">
              {formatClock(seconds)}
            </span>
            <button
              type="button"
              onClick={stopRecordingInternal}
              className="rounded-md bg-neutral-200 px-3 py-1 text-sm font-medium text-neutral-900 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-600"
            >
              Stop
            </button>
          </div>
        )}

        {!hasAudio && !isRecording && !uploading && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void startRecording()}
              className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500"
            >
              Record
            </button>
            <label className="cursor-pointer rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-800 hover:bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700">
              Upload audio
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void handleUploadFile(f);
                }}
              />
            </label>
          </div>
        )}

        {showTranscriptSection && (
          <div className="border-t border-neutral-200 pt-3 dark:border-neutral-700">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
              Transcript
            </p>
            <textarea
              value={isRecording ? liveTranscript : props.transcript}
              onChange={(e) => {
                if (isRecording) return;
                patchAudio(editor, block, props, {
                  transcript: e.target.value,
                  boot: "",
                });
              }}
              readOnly={isRecording}
              rows={Math.min(12, Math.max(3, Math.ceil((displayTranscript.length || 1) / 80)))}
              placeholder={
                isRecording
                  ? "Listening…"
                  : "Transcript appears here after recording or when you type."
              }
              className="w-full resize-y rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 dark:border-neutral-600 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
            />
            {isRecording && !getSpeechRecognitionCtor() && (
              <p className="mt-1 text-xs text-neutral-500">
                Live captions are not available in this browser; you still get the audio file.
              </p>
            )}
          </div>
        )}
      </div>
    </figure>
  );
}

export const AudioBlockSpec = createReactBlockSpec(
  {
    type: "audio" as const,
    propSchema: {
      storageKey: { default: "" },
      transcript: { default: "" },
      durationSec: { default: 0 },
      boot: { default: "" },
    },
    content: "none",
  },
  {
    render: (p) => <AudioBlockView block={p.block} editor={p.editor} />,
    toExternalHTML: () => <p />,
  }
);
