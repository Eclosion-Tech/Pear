/**
 * Transcript scribe core — writes engine-session transcripts into pear pages
 * as the ENGINE's AI user (attribution comes from the transport's token).
 *
 * Page tree:  Agent Sessions (root, find-or-create)
 *               └─ {project}            (cwd basename, find-or-create)
 *                    └─ {ts} — {title}  (one Doc per session)
 *
 * Appends are throttled (FLUSH_MS / FLUSH_EVENTS): the scribe accumulates the
 * transcript as markdown and rewrites the page body on flush — replace
 * semantics, same as the update_page_content tool. On resume the existing
 * body is re-seeded from the page so nothing is lost.
 */

import type { StdbTransport } from "../api-endpoint";
import { createPage } from "../mcp/create-page";
import { getPageRow, listChildren } from "../mcp/pages";
import { readComponentTreeDoc } from "../mcp/component-tree";
import { writePageContent } from "../mcp/write-content";
import {
  eventMarkdown,
  headerMarkdown,
  userMarkdown,
  type ScribeEngineEvent,
  type TranscriptHeader,
} from "./transcript";

export type { ScribeEngineEvent } from "./transcript";

const ROOT_TITLE = "Agent Sessions";
const FLUSH_MS = 2_000;
const FLUSH_EVENTS = 20;

export interface ScribeInit {
  engine: string;
  sessionId: string;
  title: string;
  cwd: string;
  /** Existing transcript page to continue (resume); omit to create one. */
  transcriptPageId?: number;
}

async function findOrCreateChild(
  transport: StdbTransport,
  parentId: number,
  title: string,
): Promise<number> {
  const existing = (await listChildren(transport, parentId)).find(
    (p) => p.title === title,
  );
  if (existing) return existing.id;
  const created = await createPage(transport, {
    parentId,
    pageType: "Doc",
    title,
  });
  if (!created.ok || created.page_id === undefined) {
    throw new Error(created.error ?? `create_page "${title}" failed`);
  }
  return created.page_id;
}

function projectName(cwd: string): string {
  const segments = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments[segments.length - 1] || cwd || "unknown";
}

function sessionTitle(title: string, startedAtIso: string): string {
  const stamp = startedAtIso.slice(0, 16).replace("T", " ");
  return `${stamp} — ${title || "Untitled session"}`;
}

export class TranscriptScribe {
  private lines: string[] = [];
  private pendingSinceFlush = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private dirty = false;

  private constructor(
    private readonly transport: StdbTransport,
    readonly pageId: number,
    private readonly contentFormat: "BlockNote" | "ComponentTree",
    seed: string[],
  ) {
    this.lines = seed;
  }

  /** Build (or re-open) the transcript page and return a ready scribe. */
  static async open(
    transport: StdbTransport,
    init: ScribeInit,
  ): Promise<TranscriptScribe> {
    const startedAtIso = new Date().toISOString();

    let pageId = init.transcriptPageId;
    let seed: string[] = [];
    if (pageId !== undefined && (await getPageRow(transport, pageId))) {
      const existing = await readComponentTreeDoc(transport, pageId);
      if (existing) seed = existing.split("\n");
      seed.push("", `— resumed ${startedAtIso} —`);
    } else {
      const rootId = await findOrCreateChild(transport, 0, ROOT_TITLE);
      const projectId = await findOrCreateChild(
        transport,
        rootId,
        projectName(init.cwd),
      );
      pageId = await findOrCreateChild(
        transport,
        projectId,
        sessionTitle(init.title, startedAtIso),
      );
      const header: TranscriptHeader = {
        engine: init.engine,
        sessionId: init.sessionId,
        cwd: init.cwd,
        startedAtIso,
      };
      seed = headerMarkdown(header);
    }

    const page = await getPageRow(transport, pageId);
    const scribe = new TranscriptScribe(
      transport,
      pageId,
      page?.contentFormat === "BlockNote" ? "BlockNote" : "ComponentTree",
      seed,
    );
    scribe.markDirty();
    return scribe;
  }

  appendUser(text: string): void {
    this.push(["", ...userMarkdown(text)]);
  }

  appendEvent(ev: ScribeEngineEvent): void {
    const lines = eventMarkdown(ev);
    if (lines.length > 0) this.push(["", ...lines]);
  }

  private push(lines: string[]): void {
    this.lines.push(...lines);
    this.pendingSinceFlush += 1;
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.pendingSinceFlush >= FLUSH_EVENTS) {
      void this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_MS);
    }
  }

  /** Serialize flushes; last write wins (whole-body replace). */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return this.flushing;
    this.dirty = false;
    this.pendingSinceFlush = 0;
    const body = this.lines.join("\n");
    this.flushing = this.flushing.then(async () => {
      const result = await writePageContent(
        this.transport,
        { id: this.pageId, contentFormat: this.contentFormat },
        body,
        { snapshot: false },
      );
      if (!result.ok) {
        console.error(`[scribe] flush failed: ${result.error ?? "unknown"}`);
        this.dirty = true; // retry on the next flush
      }
    });
    return this.flushing;
  }

  /** Final checkpoint — call on session end (stdin EOF in the host). */
  async close(): Promise<void> {
    await this.flush();
    await this.flushing;
  }
}
