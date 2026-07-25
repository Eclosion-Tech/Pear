/**
 * `dataSource` — the query half of the repeater primitive.
 *
 * Implements D5 of `docs/PEAR_CUSTOM_VIEW_RUNTIME_ADR.md`: a versioned,
 * bounded, typed config. Deliberately **not** Turing-shaped — no expressions,
 * no joins, no aggregation, no OR-trees. When a view outgrows this the answer
 * is a sandboxed expression (tier 4) or a module (tier 5), never query-language
 * growth.
 *
 * Pulp stays storage-agnostic: it parses and validates the config but never
 * evaluates it. The host supplies rows through a `QueryResolver` (D1), so the
 * only thing pulp knows about a row is that it has an `id`.
 */

import type { BlockId } from "../types";

/** Comparison operators. Typed property comparisons only — see D5's fences. */
export type PredicateOp =
  | "eq"
  | "neq"
  | "lt"
  | "gt"
  | "contains"
  | "isEmpty";

/** Scalar operands. No expressions — a predicate compares a property to a literal. */
export type PredicateValue = string | number | boolean | null;

export type Predicate = {
  property: string;
  op: PredicateOp;
  /** Absent for `isEmpty`, which is unary. */
  value?: PredicateValue;
};

export type SortRule = {
  property: string;
  dir: "asc" | "desc";
};

/**
 * Which rows to draw from.
 *
 * `pages` covers the sidebar and page-list shapes; `database` covers DB views
 * and is schema-chain aware from day one (`includeDescendants`) because
 * retrofitting that onto shipped configs is the trap flagged in D5.
 */
export type DataSourceEntity =
  | {
      kind: "pages";
      /** Scope root. `null`/absent means the whole workspace. */
      parentId?: BlockId | null;
      /**
       * Whole subtree rather than direct children.
       *
       * D5 declares `includeDescendants` only on `database`, but the pages
       * entity needs the same axis and needs it *now*: a recursive template
       * (the sidebar, M3) nests rows by parentage, which requires descendants,
       * not one level. Deferring it would mean shipping `v: 1` page configs
       * that cannot express the surface M3 is built on — and D5's own reasoning
       * is that retrofitting scope-chain awareness onto shipped configs is the
       * trap to avoid. Same semantics as the database variant.
       */
      includeDescendants?: boolean;
    }
  | { kind: "database"; schemaId: BlockId; includeDescendants?: boolean };

export type DataSourceConfig = {
  /**
   * Mandatory. Configs live in user-owned rows and are forever; evolution
   * happens by version, not mutation.
   */
  v: 1;
  entity: DataSourceEntity;
  /** Implicit AND across predicates. OR is deliberately absent (D5). */
  filter?: Predicate[];
  sort?: SortRule[];
  limit?: number;
};

/**
 * A row as pulp sees it: opaque beyond `id`. The host's resolver decides what
 * the other fields are — page columns, database property values, whatever.
 *
 * `parentId` is read only when the template has a recursion point (the
 * sidebar's sub-page case); resolvers over flat result sets can omit it and
 * every row materializes as a root. Rows arrive already filtered and sorted by
 * the resolver, so the materializer never re-orders them.
 */
export type RepeaterRow = {
  id: BlockId;
  parentId?: BlockId | null;
} & Record<string, unknown>;

/**
 * How the host feeds a repeater (D1).
 *
 * Delivery contract, so that swapping full re-evaluation for delta
 * maintenance later is invisible to callers (D4):
 *
 * - a new array per delivery;
 * - unchanged rows keep object identity — this is what lets the materializer's
 *   subtree memo fire, so it is load-bearing, not a nicety;
 * - a delivery that does not affect this query MAY return the identical array,
 *   letting the repeater skip materialization entirely. v1 full re-evaluation
 *   never exercises this clause; `IncrementalQuery` will.
 *
 * Binding configs never encode which strategy is in use.
 */
export type QueryResolver = {
  subscribe(
    dataSource: DataSourceConfig,
    onRows: (rows: ReadonlyArray<RepeaterRow>) => void,
  ): () => void;
};

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

const OPS: ReadonlySet<string> = new Set([
  "eq",
  "neq",
  "lt",
  "gt",
  "contains",
  "isEmpty",
]);

/**
 * Coerce a wire id to bigint. JSON has no bigint, so stored configs carry ids
 * as numbers (safe below 2^53) or strings (anything larger). Mirrors
 * `toBigId` in the web app's `componentTreeBlob`.
 */
function toBigId(v: unknown): BlockId | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) {
    return BigInt(v);
  }
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "bigint" && v >= 0n) return v;
  return null;
}

function parsePredicate(raw: unknown): Predicate | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.property !== "string" || !r.property) return null;
  if (typeof r.op !== "string" || !OPS.has(r.op)) return null;

  const op = r.op as PredicateOp;
  if (op === "isEmpty") return { property: r.property, op };

  const value = r.value;
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    return null;
  }
  return { property: r.property, op, value: value as PredicateValue };
}

function parseEntity(raw: unknown): DataSourceEntity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (r.kind === "pages") {
    const includeDescendants = r.includeDescendants === true;
    if (r.parentId === undefined || r.parentId === null) {
      return { kind: "pages", parentId: null, includeDescendants };
    }
    const parentId = toBigId(r.parentId);
    return parentId === null ? null : { kind: "pages", parentId, includeDescendants };
  }

  if (r.kind === "database") {
    const schemaId = toBigId(r.schemaId);
    if (schemaId === null) return null;
    return {
      kind: "database",
      schemaId,
      includeDescendants: r.includeDescendants === true,
    };
  }

  return null;
}

export type ParseResult =
  | { ok: true; config: DataSourceConfig }
  | { ok: false; error: string };

/**
 * Parse a `dataSource` value out of a component's props.
 *
 * Fail-soft and explicit: a malformed config yields an error string the
 * Repeater renderer surfaces in place, rather than throwing through the render
 * tree or silently rendering nothing. Same defence-in-depth stance as
 * `UnregisteredComponentFallback` — a workspace running an older build against
 * a newer tree should *see* that something is there it can't evaluate.
 */
export function parseDataSource(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "dataSource is missing or not an object" };
  }
  const r = raw as Record<string, unknown>;

  if (r.v !== 1) {
    return {
      ok: false,
      error:
        typeof r.v === "number"
          ? `unsupported dataSource version ${r.v} (this build understands v1)`
          : "dataSource.v is required",
    };
  }

  const entity = parseEntity(r.entity);
  if (!entity) return { ok: false, error: "dataSource.entity is invalid" };

  const config: DataSourceConfig = { v: 1, entity };

  if (r.filter !== undefined) {
    if (!Array.isArray(r.filter)) {
      return { ok: false, error: "dataSource.filter must be an array" };
    }
    const filter: Predicate[] = [];
    for (const p of r.filter) {
      const parsed = parsePredicate(p);
      if (!parsed) return { ok: false, error: "dataSource.filter has an invalid predicate" };
      filter.push(parsed);
    }
    if (filter.length > 0) config.filter = filter;
  }

  if (r.sort !== undefined) {
    if (!Array.isArray(r.sort)) {
      return { ok: false, error: "dataSource.sort must be an array" };
    }
    const sort: SortRule[] = [];
    for (const s of r.sort) {
      if (typeof s !== "object" || s === null) {
        return { ok: false, error: "dataSource.sort has an invalid rule" };
      }
      const sr = s as Record<string, unknown>;
      if (typeof sr.property !== "string" || !sr.property) {
        return { ok: false, error: "dataSource.sort rule needs a property" };
      }
      if (sr.dir !== "asc" && sr.dir !== "desc") {
        return { ok: false, error: "dataSource.sort rule dir must be asc or desc" };
      }
      sort.push({ property: sr.property, dir: sr.dir });
    }
    if (sort.length > 0) config.sort = sort;
  }

  if (r.limit !== undefined) {
    if (typeof r.limit !== "number" || !Number.isInteger(r.limit) || r.limit < 0) {
      return { ok: false, error: "dataSource.limit must be a non-negative integer" };
    }
    config.limit = r.limit;
  }

  return { ok: true, config };
}

/**
 * Structural equality for configs, so a repeater only re-subscribes when the
 * binding genuinely changed. Props arrive as JSON strings that are re-parsed
 * per render; without this, every render would tear down the subscription.
 */
export function dataSourceEquals(
  a: DataSourceConfig | null,
  b: DataSourceConfig | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.v !== b.v || a.limit !== b.limit) return false;

  if (a.entity.kind !== b.entity.kind) return false;
  if (a.entity.kind === "pages" && b.entity.kind === "pages") {
    if ((a.entity.parentId ?? null) !== (b.entity.parentId ?? null)) return false;
    if (!!a.entity.includeDescendants !== !!b.entity.includeDescendants) return false;
  } else if (a.entity.kind === "database" && b.entity.kind === "database") {
    if (a.entity.schemaId !== b.entity.schemaId) return false;
    if (!!a.entity.includeDescendants !== !!b.entity.includeDescendants) return false;
  }

  const af = a.filter ?? [];
  const bf = b.filter ?? [];
  if (af.length !== bf.length) return false;
  for (let i = 0; i < af.length; i++) {
    if (
      af[i].property !== bf[i].property ||
      af[i].op !== bf[i].op ||
      af[i].value !== bf[i].value
    ) {
      return false;
    }
  }

  const as = a.sort ?? [];
  const bs = b.sort ?? [];
  if (as.length !== bs.length) return false;
  for (let i = 0; i < as.length; i++) {
    if (as[i].property !== bs[i].property || as[i].dir !== bs[i].dir) return false;
  }

  return true;
}
