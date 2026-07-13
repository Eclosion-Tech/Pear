/**
 * Background Notion import executor.
 *
 * Runs on the DatabaseWorker's admin connection (module publisher — the
 * job reducers are publisher-gated). Watches `notion_import_job` for Pending
 * rows enqueued by the web app, then: claim → decrypt token (key from worker
 * env) → fetch the shared Notion selection → re-home attachments (S3 +
 * lifecycle blob registry) → transform → `complete_notion_import_job`, which
 * applies the payload atomically in the module. Progress is streamed onto the
 * job row, which the requesting user's settings panel renders live.
 *
 * Replaces the Vercel-function orchestration path, which could not survive
 * large imports (platform execution ceiling) and required the browser to
 * relay the payload.
 */
import { fetchNotionWorkspace } from "./fetcher.js";
import { transformNotionToPayload } from "./transformer.js";
import { uploadNotionAttachments } from "./attachments.js";
import { decryptNotionTokenB64 } from "./token-crypto.js";

type JobStatusTag = "Pending" | "Running" | "Done" | "Failed";

export type NotionImportJobRow = {
  id: bigint;
  requestedBy: { toHexString(): string };
  encryptedTokenB64: string;
  sourceName: string;
  workspaceSlug: string;
  status: { tag: JobStatusTag };
};

type JobReducers = {
  claimNotionImportJob(args: { jobId: bigint; workerId: string }): Promise<unknown>;
  updateNotionImportJob(args: {
    jobId: bigint;
    stage: string;
    pagesDone: number;
    pagesTotal: number;
  }): Promise<unknown>;
  completeNotionImportJob(args: { jobId: bigint; snapshotJson: string }): Promise<unknown>;
  failNotionImportJob(args: { jobId: bigint; error: string }): Promise<unknown>;
};

type JobConn = {
  reducers: JobReducers;
  db: {
    notion_import_job?: {
      iter(): Iterable<NotionImportJobRow>;
      onInsert(cb: (ctx: unknown, row: NotionImportJobRow) => void): void;
      onUpdate(cb: (ctx: unknown, old: NotionImportJobRow, row: NotionImportJobRow) => void): void;
    };
  };
};

/** Parse "…N/M…" progress counters out of fetcher log lines, best-effort. */
function parseCounts(msg: string): { done: number; total: number } | null {
  const m = msg.match(/(\d+)\/(\d+)/);
  if (!m) return null;
  return { done: Number(m[1]), total: Number(m[2]) };
}

export class NotionImportJobRunner {
  private inFlight = new Set<bigint>();

  constructor(
    private readonly dbName: string,
    private readonly workerId: string,
  ) {}

  /** Register row handlers; call once per (re)connection before subscribing. */
  attach(conn: unknown): void {
    const c = conn as JobConn;
    const table = c.db.notion_import_job;
    if (!table) return; // module predates the job table
    table.onInsert((_ctx, row) => void this.maybeRun(c, row));
    table.onUpdate((_ctx, _old, row) => void this.maybeRun(c, row));
  }

  /** Scan for pre-existing pending jobs; call from the subscription-ready hook. */
  scan(conn: unknown): void {
    const c = conn as JobConn;
    const table = c.db.notion_import_job;
    if (!table) return;
    for (const row of table.iter()) void this.maybeRun(c, row);
  }

  private async maybeRun(conn: JobConn, job: NotionImportJobRow): Promise<void> {
    if (job.status.tag !== "Pending" || this.inFlight.has(job.id)) return;
    this.inFlight.add(job.id);
    const tag = `[notion-import:${this.dbName}] job ${job.id}`;
    try {
      await conn.reducers.claimNotionImportJob({ jobId: job.id, workerId: this.workerId });
    } catch (err) {
      // Another worker instance claimed it first, or we lack authority.
      console.log(`${tag}: claim skipped:`, err instanceof Error ? err.message : err);
      this.inFlight.delete(job.id);
      return;
    }

    let lastProgressAt = 0;
    const progress = (msg: string): void => {
      console.log(`${tag}: ${msg}`);
      const now = Date.now();
      // At most ~1 reducer call/sec — fetcher logs are bursty.
      if (now - lastProgressAt < 1000) return;
      lastProgressAt = now;
      const counts = parseCounts(msg) ?? { done: 0, total: 0 };
      void conn.reducers
        .updateNotionImportJob({
          jobId: job.id,
          stage: msg,
          pagesDone: counts.done,
          pagesTotal: counts.total,
        })
        .catch(() => {});
    };

    try {
      const token = decryptNotionTokenB64(job.encryptedTokenB64);
      const fetchResult = await fetchNotionWorkspace(token, progress);
      const uploaded = await uploadNotionAttachments(
        this.dbName,
        fetchResult.attachmentRefs,
        job.requestedBy.toHexString(),
        progress,
      );
      progress("Transforming into Pear format…");
      const payload = transformNotionToPayload(
        fetchResult,
        uploaded,
        job.requestedBy.toHexString(),
        job.workspaceSlug,
        job.sourceName,
      );
      progress("Writing into the workspace…");
      await conn.reducers.completeNotionImportJob({
        jobId: job.id,
        snapshotJson: JSON.stringify(payload),
      });
      console.log(`${tag}: complete`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag}: FAILED — ${msg}`);
      await conn.reducers
        .failNotionImportJob({ jobId: job.id, error: msg.slice(0, 2000) })
        .catch(() => {});
    } finally {
      this.inFlight.delete(job.id);
    }
  }
}
