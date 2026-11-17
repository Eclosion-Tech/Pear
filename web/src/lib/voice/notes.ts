import { NOTES_SYSTEM_PROMPT, notesUserMessage } from "./prompts";
import type { VoiceNotes, VoiceNotesInput, VoiceUpstream } from "./types";
import { isOpenRouter, upstreamError, upstreamHeaders, upstreamUrl } from "./upstream";

/**
 * Works out which items the caller's latest words decided. Runs apart from
 * the spoken reply, so interrupting the reply does not lose the answer.
 *
 * Only items on the sheet can be recorded, whatever the model returns.
 */
export async function takeVoiceNotes(
  upstream: VoiceUpstream,
  model: string,
  input: VoiceNotesInput,
  signal?: AbortSignal,
): Promise<VoiceNotes> {
  const body: Record<string, unknown> = {
    model,
    temperature: 0,
    max_tokens: 500,
    messages: [
      { role: "system", content: NOTES_SYSTEM_PROMPT },
      { role: "user", content: notesUserMessage(input) },
    ],
  };
  // Reasoning first would only delay the record.
  if (isOpenRouter(upstream)) body.reasoning = { effort: "none" };
  const res = await (upstream.fetch ?? fetch)(upstreamUrl(upstream, "notes"), {
    method: "POST",
    headers: upstreamHeaders(upstream),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await upstreamError(res));
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: unknown };
  const content = typeof json.choices?.[0]?.message?.content === "string" ? (json.choices[0].message.content as string) : "";
  // Models sometimes wrap the JSON in a sentence or a code fence.
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`notes were not JSON: ${content.slice(0, 120)}`);
  let parsed: { decisions?: unknown; current_item?: unknown };
  try {
    parsed = JSON.parse(content.slice(start, end + 1)) as { decisions?: unknown; current_item?: unknown };
  } catch {
    throw new Error(`notes were not JSON: ${content.slice(0, 120)}`);
  }

  const ids = new Set(input.items.map((item) => item.id));
  const decisions: VoiceNotes["decisions"] = [];
  for (const raw of Array.isArray(parsed.decisions) ? parsed.decisions : []) {
    const entry = raw as { item?: unknown; decision?: unknown; quote?: unknown } | null;
    if (!entry || typeof entry.item !== "string" || !ids.has(entry.item)) continue;
    if (typeof entry.decision !== "string" || !entry.decision.trim()) continue;
    decisions.push({
      item: entry.item,
      decision: entry.decision.trim(),
      quote: typeof entry.quote === "string" && entry.quote.trim() ? entry.quote.trim() : input.callerSaid,
    });
  }
  const current = typeof parsed.current_item === "string" && ids.has(parsed.current_item) ? parsed.current_item : null;
  return { decisions, currentItem: current, usage: json.usage ?? null };
}
