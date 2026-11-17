import type { VoiceUpstream } from "./types";

/**
 * OpenRouter and OpenAI differ in a few request fields. Everything else is
 * the shared OpenAI-compatible shape.
 */
export function isOpenRouter(upstream: VoiceUpstream): boolean {
  if (upstream.dialect) return upstream.dialect === "openrouter";
  try {
    return new URL(upstream.baseUrl).hostname === "openrouter.ai";
  } catch {
    return false;
  }
}

const DEFAULT_PATHS = { talk: "/chat/completions", transcribe: "/audio/transcriptions", notes: "/chat/completions" } as const;

export function upstreamUrl(upstream: VoiceUpstream, call: keyof typeof DEFAULT_PATHS): string {
  return `${upstream.baseUrl.replace(/\/$/, "")}${upstream.paths?.[call] ?? DEFAULT_PATHS[call]}`;
}

export function upstreamHeaders(upstream: VoiceUpstream, contentType: string | null = "application/json"): Record<string, string> {
  const headers: Record<string, string> = {};
  if (upstream.apiKey) headers.Authorization = `Bearer ${upstream.apiKey}`;
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

/** A short, single-line account of a failed upstream response. Never includes the key. */
export async function upstreamError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return `HTTP ${res.status}: ${body.replace(/\s+/g, " ").slice(0, 300)}`;
}

/**
 * Reads a server-sent event stream and calls onEvent with each parsed JSON
 * payload. onEvent returns true to stop early, which closes the connection.
 * An aborted read ends quietly.
 */
export async function readEvents(res: Response, onEvent: (json: Record<string, unknown>) => boolean | void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue; // blank lines and ": comment" keep-alives
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (onEvent(json) === true) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
  } catch (error) {
    if ((error as { name?: string } | null)?.name !== "AbortError") throw error;
  }
}
