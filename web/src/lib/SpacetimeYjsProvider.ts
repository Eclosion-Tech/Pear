import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

/**
 * Minimal Yjs provider that uses SpacetimeDB as its transport layer.
 *
 * How it works:
 * 1. Outgoing: local Y.Doc updates are buffered and flushed as a single merged
 *    update every FLUSH_INTERVAL_MS. This keeps the SpacetimeDB row count low
 *    and reduces the number of echoes the editor has to process.
 * 2. Incoming: PearEditor calls `applyUpdate()` for each arriving row. We use
 *    `Y.diffUpdate` to skip anything already in the doc (echoes of our own
 *    keystrokes). Only genuinely new content reaches `Y.applyUpdate`.
 *
 * BlockNote's `collaboration` option requires the provider to expose an
 * `awareness` property (from y-protocols) for cursor / presence tracking.
 */

/** Maximum ms before pending outgoing updates are flushed to SpacetimeDB. */
const FLUSH_INTERVAL_MS = 100;

/** Byte length of an empty Yjs update (0 structs + empty delete set). */
const EMPTY_UPDATE_BYTES = 2;

export class SpacetimeYjsProvider {
  public readonly awareness: Awareness;

  /** Set to true during bulk operations (e.g. legacy-content migration) to
   *  suppress individual update sends so we can batch into one snapshot. */
  public paused = false;

  private readonly updateHandler: (update: Uint8Array, origin: unknown) => void;
  private pending: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public readonly doc: Y.Doc,
    private readonly onSend: (data: Uint8Array) => void
  ) {
    this.awareness = new Awareness(doc);

    this.updateHandler = (update, origin) => {
      // Don't re-broadcast updates we applied from remote (origin === this)
      // and don't send anything while paused (migration batch mode).
      if (origin === this || this.paused) return;
      this.pending.push(update);
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
      }
    };

    doc.on("update", this.updateHandler);
  }

  /**
   * Apply an incoming Yjs update from SpacetimeDB.
   *
   * Before touching the Y.Doc we compute the diff between the incoming data
   * and the doc's current state vector. If the diff is empty the update is
   * already fully reflected in the doc (it's an echo of something we sent) —
   * we return immediately so the Y.Doc is never disturbed and no Yjs observers
   * fire, preventing a spurious BlockNote reconciliation on every keystroke.
   */
  applyUpdate(data: Uint8Array) {
    const sv = Y.encodeStateVector(this.doc);
    const diff = Y.diffUpdate(data, sv);
    if (diff.length <= EMPTY_UPDATE_BYTES) return;
    Y.applyUpdate(this.doc, diff, this);
  }

  private flush() {
    this.flushTimer = null;
    if (this.pending.length === 0) return;
    const merged =
      this.pending.length === 1
        ? this.pending[0]
        : Y.mergeUpdates(this.pending);
    this.pending = [];
    this.onSend(merged);
  }

  destroy() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flush();
    }
    this.doc.off("update", this.updateHandler);
    this.awareness.destroy();
  }
}
