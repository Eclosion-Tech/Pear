"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CreateAttachmentFn } from "@/src/components/AudioAttachmentContext";
import {
  uploadWorkspaceBlob,
  usePearWorkspaceSlug,
  workspaceBlobSrc,
} from "@/src/lib/blobUpload";

export type AudioBlockPatch = {
  storageKey?: string;
  transcript?: string;
  durationSec?: number;
  boot?: string;
};

type AudioBlockContentProps = {
  storageKey: string;
  transcript: string;
  durationSec: number;
  boot: string;
  onPatch: (patch: AudioBlockPatch) => void;
  attachmentCtx: {
    pageId: bigint;
    createAttachment: CreateAttachmentFn;
  } | null;
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
  // @assistant-ui/core (via @eclosion-tech/chat) ships its own Web Speech
  // globals whose Window.SpeechRecognition type wins over ours in
  // src/types/speech-recognition.d.ts; both describe the same runtime
  // constructor, so bridge the declaration mismatch here.
  return (window.SpeechRecognition ??
    window.webkitSpeechRecognition ??
    null) as (new () => SpeechRecognition) | null;
}

async function uploadAudioBlob(
  slug: string,
  pageId: bigint,
  blob: Blob,
  filename: string,
  contentType: string,
  createAttachment: CreateAttachmentFn,
): Promise<string | null> {
  const up = await uploadWorkspaceBlob({ slug, body: blob, contentType });
  if (!up) return null;
  createAttachment({
    pageId,
    filename,
    contentType,
    storageKey: up.objectId,
    sizeBytes: BigInt(blob.size),
  });
  return up.objectId;
}

function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Shared audio block UI — used by ComponentTree `Audio` and BlockNote `AudioBlock`. */
export function AudioBlockContent({
  storageKey,
  transcript,
  durationSec,
  boot,
  onPatch,
  attachmentCtx,
}: AudioBlockContentProps) {
  const workspaceSlug = usePearWorkspaceSlug();
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
    async (blob: Blob, mimeType: string, finalTranscript: string, dur: number) => {
      if (!attachmentCtx) return;
      setUploading(true);
      setError(null);
      try {
        const ext =
          mimeType.includes("ogg") || mimeType.includes("opus") ? ".ogg" : ".webm";
        const key = await uploadAudioBlob(
          workspaceSlug,
          attachmentCtx.pageId,
          blob,
          `recording-${Date.now()}${ext}`,
          mimeType || "audio/webm",
          attachmentCtx.createAttachment,
        );
        if (!key) {
          setError("Upload failed");
          return;
        }
        onPatch({
          storageKey: key,
          transcript: finalTranscript,
          durationSec: dur,
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
    [attachmentCtx, onPatch, workspaceSlug],
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
    if (!attachmentCtx) {
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
      const blob = new Blob(chunksRef.current, { type });
      chunksRef.current = [];
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
      setIsRecording(false);
      void finalizeUpload(
        blob,
        type,
        liveTranscriptRef.current.trim(),
        secondsRef.current,
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
  }, [attachmentCtx, finalizeUpload]);

  startRecordingRef.current = startRecording;

  useLayoutEffect(() => {
    if (boot !== "record") return;
    if (bootHandledRef.current) return;
    bootHandledRef.current = true;
    onPatch({ boot: "" });
    void startRecordingRef.current();
  }, [boot, onPatch]);

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
    if (!attachmentCtx) return;
    setUploading(true);
    setError(null);
    try {
      const key = await uploadAudioBlob(
        workspaceSlug,
        attachmentCtx.pageId,
        file,
        file.name || "audio",
        file.type || "audio/webm",
        attachmentCtx.createAttachment,
      );
      if (!key) {
        setError("Upload failed");
        return;
      }
      onPatch({
        storageKey: key,
        transcript,
        durationSec,
        boot: "",
      });
    } catch (e) {
      console.error("[AudioBlock] file upload", e);
      setError("Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const displayTranscript = (transcript || liveTranscript).trim();
  const hasAudio = Boolean(storageKey);
  const src = hasAudio ? workspaceBlobSrc(workspaceSlug, storageKey) : "";
  const showTranscriptSection = hasAudio || isRecording || Boolean(displayTranscript);

  if (!attachmentCtx) {
    return (
      <figure className="my-3 rounded-lg border border-dashed border-amber-300 bg-amber-50/50 p-4 text-sm text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
        Audio block is unavailable (missing editor context).
      </figure>
    );
  }

  return (
    <figure className="my-3 rounded-lg border border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900/40">
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
              value={isRecording ? liveTranscript : transcript}
              onChange={(e) => {
                if (isRecording) return;
                onPatch({ transcript: e.target.value, boot: "" });
              }}
              readOnly={isRecording}
              rows={Math.min(
                12,
                Math.max(3, Math.ceil((displayTranscript.length || 1) / 80)),
              )}
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
