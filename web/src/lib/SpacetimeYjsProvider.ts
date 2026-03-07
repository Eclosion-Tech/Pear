import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

/**
 * Minimal Yjs provider that uses SpacetimeDB as its transport layer.
 *
 * How it works:
 * 1. Outgoing: every local Y.Doc update is forwarded to SpacetimeDB via the
 *    `onSend` callback (which calls the `applyYjsUpdate` reducer).
 * 2. Incoming: the PearEditor component calls `applyUpdate()` whenever a new
 *    `page_yjs_update` row arrives from the SpacetimeDB subscription.
 *    Updates are applied with `this` as the origin so the outgoing handler
 *    won't re-broadcast them (preventing an echo loop).
 *
 * BlockNote's `collaboration` option requires the provider to expose an
 * `awareness` property (from y-protocols) for cursor / presence tracking.
 */
export class SpacetimeYjsProvider {
  public readonly awareness: Awareness;

  /** Set to true during bulk operations (e.g. legacy-content migration) to
   *  suppress individual update sends so we can batch into one snapshot. */
  public paused = false;

  private readonly updateHandler: (update: Uint8Array, origin: unknown) => void;

  constructor(
    public readonly doc: Y.Doc,
    private readonly onSend: (data: Uint8Array) => void
  ) {
    this.awareness = new Awareness(doc);

    this.updateHandler = (update, origin) => {
      // Don't re-broadcast updates we applied from remote (origin === this)
      // and don't send anything while paused (migration batch mode).
      if (origin === this || this.paused) return;
      onSend(update);
    };

    doc.on("update", this.updateHandler);
  }

  /**
   * Apply a remote Yjs update received from SpacetimeDB.
   * Passing `this` as origin prevents the updateHandler from echoing it back.
   */
  applyUpdate(data: Uint8Array) {
    Y.applyUpdate(this.doc, data, this);
  }

  destroy() {
    this.doc.off("update", this.updateHandler);
    this.awareness.destroy();
  }
}
