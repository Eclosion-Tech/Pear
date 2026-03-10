import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

/**
 * Minimal Yjs provider stub for BlockNote's collaboration mode.
 *
 * With the simplified storage architecture (IndexedDB-primary, periodic
 * SpacetimeDB save), this class only needs to:
 *   1. Expose an `awareness` object — required by BlockNote's collaboration API
 *      for future cursor/presence support.
 *   2. Provide a `destroy()` hook for cleanup.
 *
 * Sending/receiving Yjs updates is handled entirely by PearEditor:
 *   - Outgoing: periodic `save_yjs_state` reducer calls (full merged state blob)
 *   - Incoming: on fresh load, apply `PageYjsState.data` from SpacetimeDB once
 *   - Local: IndexedDB (`y-indexeddb`) persists every op immediately
 *
 * When real-time multi-user collaboration is added (§17 of PEAR_MVP.md),
 * this class will grow to handle incremental update broadcasting again.
 */
export class SpacetimeYjsProvider {
  public readonly awareness: Awareness;

  constructor(public readonly doc: Y.Doc) {
    this.awareness = new Awareness(doc);
  }

  destroy() {
    this.awareness.destroy();
  }
}
