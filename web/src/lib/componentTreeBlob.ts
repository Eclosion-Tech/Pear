import type {
  BlockNode,
  BlockTree,
  BlockTypeDefinition,
  BlockYjsState,
} from "@eclosion-tech/pulp";

/**
 * Parse a `component_tree_v1` JSON blob (the shape produced by the server's
 * `serialize_component_tree`) into an in-memory pulp `BlockTree`, ready for
 * read-only rendering via `<BlockView>`.
 *
 * This is the client counterpart of the server serializer — used for
 * generative chat UI, where an assistant message carries a component tree
 * inline rather than referencing a persisted surface. `defs` come from the
 * live `component_type_definition` subscription (renderers rely on
 * `acceptsChildren` / `propSchema`); the blob only carries structure + content.
 *
 * Fails soft: any malformed / unversioned / rootless blob returns
 * `{ ok: false }` so callers can render a small fallback instead of throwing.
 *
 * ID precision note: `serialize_component_tree` emits `id` / `parent_id` as
 * raw u64 numbers, which lose precision above 2^53 once `JSON.parse` reads
 * them. Inline chat trees are authored with small sequential ids, so this is
 * safe today; `toBigId` also accepts string ids for a future hardening that
 * switches the wire format to strings.
 */

export const COMPONENT_TREE_V1 = "component_tree_v1";

type RawNode = {
  id: number | string;
  parent_id: number | string | null;
  component_type: string;
  props: string;
  order: number;
  yjs_b64: string | null;
};

type RawBlob = {
  v: string;
  root_id: number | string | null;
  nodes: RawNode[];
};

export type ParsedComponentTree =
  | { ok: true; tree: BlockTree }
  | { ok: false; error: string };

export function parseComponentTreeBlob(
  json: string,
  defs: Map<string, BlockTypeDefinition>,
): ParsedComponentTree {
  let raw: RawBlob;
  try {
    raw = JSON.parse(json) as RawBlob;
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (!raw || raw.v !== COMPONENT_TREE_V1) {
    return {
      ok: false,
      error: `unsupported component-tree version: ${raw?.v ?? "(none)"}`,
    };
  }
  if (!Array.isArray(raw.nodes)) {
    return { ok: false, error: "missing nodes[]" };
  }

  // Ephemeral tree — no persisted surface. Renderers don't read surfaceId, so
  // a synthetic value is fine.
  const SURFACE_ID = 0n;
  const byId = new Map<bigint, BlockNode>();
  const byParent = new Map<bigint | null, BlockNode[]>();
  const yjs = new Map<bigint, BlockYjsState>();

  for (const n of raw.nodes) {
    const id = toBigId(n.id);
    if (id == null) return { ok: false, error: "node with invalid id" };
    let parentId: bigint | null;
    if (n.parent_id == null) {
      parentId = null;
    } else {
      const pid = toBigId(n.parent_id);
      if (pid == null) {
        return { ok: false, error: `node ${id} has invalid parent_id` };
      }
      parentId = pid;
    }
    const node: BlockNode = {
      id,
      surfaceId: SURFACE_ID,
      parentId,
      componentType: n.component_type,
      props: typeof n.props === "string" ? n.props : "{}",
      order: typeof n.order === "number" ? n.order : 0,
    };
    byId.set(id, node);
    const arr = byParent.get(parentId);
    if (arr) arr.push(node);
    else byParent.set(parentId, [node]);

    if (n.yjs_b64) {
      const data = base64ToBytes(n.yjs_b64);
      if (data) yjs.set(id, { componentNodeId: id, data });
    }
  }

  for (const arr of byParent.values()) {
    arr.sort((a, b) => {
      const ao = Number(a.order);
      const bo = Number(b.order);
      return ao < bo ? -1 : ao > bo ? 1 : 0;
    });
  }

  // Root: prefer the explicit root_id; fall back to the parent==null bucket.
  let root: BlockNode | null = null;
  if (raw.root_id != null) {
    const rid = toBigId(raw.root_id);
    if (rid != null) root = byId.get(rid) ?? null;
  }
  if (!root) {
    const bucket = byParent.get(null);
    root = bucket && bucket.length > 0 ? bucket[0] : null;
  }
  if (!root) return { ok: false, error: "no root node" };

  return { ok: true, tree: { root, byId, byParent, defs, yjs, loading: false } };
}

/** Coerce a wire id (number or string) to bigint; `null` if malformed. */
function toBigId(v: number | string): bigint | null {
  try {
    if (typeof v === "number") {
      return Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
    }
    if (typeof v === "string" && v.trim() !== "") return BigInt(v);
    return null;
  } catch {
    return null;
  }
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin =
      typeof atob === "function"
        ? atob(b64)
        : Buffer.from(b64, "base64").toString("binary");
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}
