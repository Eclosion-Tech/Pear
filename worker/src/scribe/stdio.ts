/**
 * Transcript scribe — stdio host.
 *
 * Spawned by the desktop app once per engine session. Reads JSONL commands on
 * stdin, writes the transcript into pear pages as the engine's AI user, and
 * prints exactly one JSON line on stdout: {"transcript_page_id": N}.
 * stdin EOF = session over → final flush, exit 0.
 *
 * stdin protocol (one JSON object per line):
 *   {"type":"init","engine":"codex","sessionId":"…","title":"…","cwd":"…",
 *    "transcriptPageId":123?}                      ← first line, required
 *   {"type":"user","text":"…"}                     ← a user turn
 *   {"type":"event","event":{"kind":"assistantMessage",…}}  ← engine event
 *
 * Environment variables (same contract as the MCP stdio host):
 *   SPACETIMEDB_URI, SPACETIMEDB_DB_NAME, PEAR_MCP_TOKEN
 */

// MUST stay the first import — stdout is reserved for the page-id line.
import "../mcp/stdio-prelude.js";

import * as readline from "node:readline";
import {
  TranscriptScribe,
  type ScribeEngineEvent,
} from "../../../web/src/lib/scribe/index.js";
import { HttpStdbTransport } from "../../../web/src/lib/mcp/index.js";
import { wsUriToHttpBase } from "../bridge-sql.js";

const uri = process.env.SPACETIMEDB_URI ?? "ws://localhost:3000";
const dbName = process.env.SPACETIMEDB_DB_NAME ?? "pear-dev";
const token = process.env.PEAR_MCP_TOKEN;

if (!token) {
  console.error("[scribe] PEAR_MCP_TOKEN is required (AI-user worker token).");
  process.exit(1);
}

type StdinLine =
  | {
      type: "init";
      engine: string;
      sessionId: string;
      title: string;
      cwd: string;
      transcriptPageId?: number;
    }
  | { type: "user"; text: string }
  | { type: "event"; event: ScribeEngineEvent };

async function main(): Promise<void> {
  const transport = new HttpStdbTransport({
    baseUrl: wsUriToHttpBase(uri),
    dbName,
    token: token!,
    timeoutMs: 15_000,
  });

  let scribe: TranscriptScribe | null = null;
  let opening: Promise<void> | null = null;
  // Lines that arrive while the page tree is still being built.
  const backlog: StdinLine[] = [];

  function apply(line: StdinLine): void {
    if (!scribe) return;
    if (line.type === "user") scribe.appendUser(line.text);
    else if (line.type === "event") scribe.appendEvent(line.event);
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    let line: StdinLine;
    try {
      line = JSON.parse(trimmed) as StdinLine;
    } catch {
      console.error(`[scribe] skipping unparseable line: ${trimmed.slice(0, 120)}`);
      return;
    }

    if (line.type === "init") {
      if (opening) return; // duplicate init — ignore
      opening = TranscriptScribe.open(transport, {
        engine: line.engine,
        sessionId: line.sessionId,
        title: line.title,
        cwd: line.cwd,
        transcriptPageId: line.transcriptPageId,
      })
        .then((s) => {
          scribe = s;
          process.stdout.write(
            `${JSON.stringify({ transcript_page_id: s.pageId })}\n`,
          );
          for (const queued of backlog) apply(queued);
          backlog.length = 0;
        })
        .catch((err: unknown) => {
          console.error(
            "[scribe] failed to open transcript page:",
            err instanceof Error ? err.message : err,
          );
          process.exit(1);
        });
      return;
    }

    if (scribe) apply(line);
    else backlog.push(line);
  });

  await new Promise<void>((resolve) => rl.once("close", resolve));
  // stdin EOF — session ended. Make sure a late init still settles, then
  // checkpoint whatever we have.
  if (opening) await opening.catch(() => undefined);
  if (scribe !== null) await (scribe as TranscriptScribe).close();
  process.exit(0);
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((err: unknown) => {
  console.error("[scribe] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
