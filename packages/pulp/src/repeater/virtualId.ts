/**
 * Stable synthetic ids for virtual (materialized) nodes — ADR D2.
 *
 * Virtual nodes are never persisted, never reducer-visible, and never
 * serialized into snapshots. But their ids are load-bearing at render time:
 * they become React keys, so **stability across re-materializations is the
 * whole point**. Unstable ids churn keys and turn every update into an
 * unmount/remount, which is precisely the cost the incremental materializer
 * exists to avoid.
 *
 * ## Why not the spike's layout
 *
 * `spikes/repeater-bench` used `bit62 | rowId << 8 | slot`. The ADR flags it as
 * a placeholder, not the decision, for two reasons that are reachable at M2/M3
 * rather than some distant milestone:
 *
 * 1. it throws above 255 template slots, and a single template can exceed 255
 *    nodes;
 * 2. it cannot express two repeaters over the same row, and a page can host
 *    more than one.
 *
 * Both are fixed here by hashing the full `(repeaterId, rowId, slot)` tuple
 * instead of packing it. Hashing also removes the slot-width cap entirely —
 * there is no structural limit on template size.
 *
 * ## Namespace
 *
 * Real ids are SpacetimeDB `u64` auto-inc values, so every real id is `< 2^64`.
 * Setting bit 64 puts virtual ids *outside the u64 domain altogether*, which
 * makes disjointness a structural property rather than a probabilistic one.
 * (The ADR notes a bit-62 namespace starts colliding once real ids reach ~2^54;
 * bit 64 has no such ceiling.) This is free because virtual ids are JS bigints
 * that never round-trip through storage — nothing requires them to fit in 64
 * bits.
 *
 * ## Collision budget
 *
 * The tuple hashes into 62 bits. A collision is *silent wrong-subtree reuse*,
 * not a crash, so the width is chosen deliberately rather than by feel:
 *
 * | live virtual nodes | P(any collision) ≈ n²/2^63 |
 * |--------------------|----------------------------|
 * | 10^4               | ~1.1e-11                   |
 * | 10^5               | ~1.1e-9                    |
 * | 10^6               | ~1.1e-7                    |
 *
 * A 10k-row Table view — the largest surface M4 contemplates — sits in the
 * first row of that table. `limit` and windowing bound the population from
 * above, so the budget does not silently erode as workspaces grow.
 */

import type { BlockId } from "../types";

const MASK64 = (1n << 64n) - 1n;
const MASK62 = (1n << 62n) - 1n;

/**
 * Bit 64: above the entire u64 row-id domain, so `isVirtualId` is exact rather
 * than heuristic.
 */
export const VIRTUAL_NAMESPACE = 1n << 64n;

/** splitmix64 finalizer — cheap, well-distributed, no dependencies. */
function mix(z: bigint): bigint {
  let x = (z + 0x9e3779b97f4a7c15n) & MASK64;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (x ^ (x >> 31n)) & MASK64;
}

/**
 * Deterministic id for one template position instantiated against one row by
 * one repeater.
 *
 * Pure: the same tuple always yields the same id, in this process and the next.
 * That is what lets a re-materialization reuse React's existing DOM instead of
 * rebuilding it.
 *
 * @param repeaterId stored id of the `Repeater` node — the per-repeater
 *   discriminator that lets two repeaters bind the same rows on one page
 * @param rowId the source row
 * @param slot pre-order index of the position within the template
 */
export function virtualId(
  repeaterId: BlockId,
  rowId: BlockId,
  slot: number,
): BlockId {
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(`virtualId: slot must be a non-negative integer, got ${slot}`);
  }
  let h = mix(BigInt(repeaterId));
  h = mix(h ^ BigInt(rowId));
  h = mix(h ^ BigInt(slot));
  return VIRTUAL_NAMESPACE | (h & MASK62);
}

/**
 * True for ids produced by `virtualId`. Exact — no real `u64` id can reach the
 * namespace bit.
 *
 * Used by the editor to withhold structural affordances (drag, slash insert,
 * turn-into, structural selection) from materialized subtrees, per D2.
 */
export function isVirtualId(id: BlockId): boolean {
  return id >= VIRTUAL_NAMESPACE;
}
