import { aiUserHostUrl, isAiUserHostDelegated } from "../aiUserApi";
import type { VoiceModels, VoiceUpstream } from "@eclosion-tech/chat-voice";

/**
 * Voice calls through the host.
 *
 * A page never holds an AI user's model key. Where a host application manages
 * AI users (Pear Cloud), it also exposes the three model calls a voice turn
 * needs, under the same AI-user API base, and attaches the key itself. Where
 * there is no host, there is no voice.
 */

export interface VoiceAvailability {
  available: boolean;
  /** Why not, in words for the person looking at the button. */
  reason?: string;
  models?: VoiceModels;
  defaultVoice?: string;
  dialect?: "openrouter" | "openai";
}

const NO_HOST: VoiceAvailability = { available: false, reason: "Voice calls are not set up on this Pear." };

const withCredentials: typeof fetch = (input, init) => fetch(input, { ...init, credentials: "same-origin", cache: "no-store" });

/** Why the host said no, in words for the person who pressed Call. */
async function refusal(res: Response): Promise<string> {
  if (res.status === 404) return "This AI user cannot take voice calls.";
  if (res.status === 401) return "Your sign-in has expired. Reload the page and try again.";
  let detail = "";
  try {
    const text = (await res.text()).trim();
    const body = text.startsWith("{") ? (JSON.parse(text) as { error?: unknown }) : null;
    detail = typeof body?.error === "string" ? body.error : text.replace(/\s+/g, " ").slice(0, 120);
  } catch {
    // The status alone still says more than nothing.
  }
  return `Voice calls are unavailable right now (the server answered ${res.status}${detail ? `: ${detail}` : ""}).`;
}

function voiceBase(aiUserId: bigint | number): string {
  return aiUserHostUrl(`/${aiUserId.toString()}/voice`);
}

/** Asks the host whether this AI user can take a call. Never throws. */
export async function fetchVoiceAvailability(aiUserId: bigint | number, doFetch: typeof fetch = withCredentials): Promise<VoiceAvailability> {
  if (!isAiUserHostDelegated()) return NO_HOST;
  try {
    const res = await doFetch(`${voiceBase(aiUserId)}/config`, { method: "GET" });
    if (!res.ok) return { available: false, reason: await refusal(res) };
    const body = (await res.json()) as Partial<VoiceAvailability>;
    if (body.available !== true) return { available: false, reason: typeof body.reason === "string" ? body.reason : "Voice calls are unavailable for this AI user." };
    const models = body.models;
    if (!models || typeof models.talker !== "string" || typeof models.transcribe !== "string" || typeof models.notes !== "string") {
      return { available: false, reason: "Voice calls are unavailable right now (the server's answer was incomplete)." };
    }
    return {
      available: true,
      models: { talker: models.talker, transcribe: models.transcribe, notes: models.notes },
      defaultVoice: typeof body.defaultVoice === "string" ? body.defaultVoice : undefined,
      dialect: body.dialect === "openai" ? "openai" : "openrouter",
    };
  } catch {
    return { available: false, reason: "Voice calls are unavailable right now (the request did not go through)." };
  }
}

/**
 * Where a call with this AI user sends its three model requests. The host
 * chooses the models and attaches the key; the names sent from here are
 * ignored there.
 */
export function hostVoiceUpstream(aiUserId: bigint | number, availability: VoiceAvailability, doFetch: typeof fetch = withCredentials): VoiceUpstream {
  return {
    baseUrl: voiceBase(aiUserId),
    dialect: availability.dialect ?? "openrouter",
    paths: { talk: "/talk", transcribe: "/transcribe", notes: "/notes" },
    fetch: doFetch,
  };
}
