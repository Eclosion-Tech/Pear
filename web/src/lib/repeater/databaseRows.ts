/**
 * `database` entity rows for the repeater (custom-view runtime, M4).
 *
 * A database row is a child page of a Database page, and its cells live in
 * `page_property_value` keyed by `property_definition_id`. This flattens that
 * join into a plain record — `{ id, parentId, title, Status: "In Progress", … }`
 * — so a template can say `{{row.Status}}` and a `dataSource` filter can say
 * `{ property: "Status", op: "eq", value: "In Progress" }` without knowing
 * anything about property ids.
 *
 * ## Identity preservation is the whole design
 *
 * The materializer reuses a row's subtree only when the row object is
 * *identically the same object* as last delivery. Page rows from `useTable`
 * already have stable identity, but a flattened row is composed from a page plus
 * N value rows, so a naive implementation builds a new object every delivery and
 * silently degrades the runtime to naive rebuild — the 12x that D3 exists to
 * avoid, with correct pixels the whole time.
 *
 * `DatabaseRowCache` therefore memoizes per page id and rebuilds a row only when
 * its page row or one of its value rows actually changed identity.
 */

import type { RepeaterRow } from "@eclosion-tech/pulp";

type PageLike = {
  id: bigint;
  parentId?: bigint | undefined;
  title: string;
  isHidden: boolean;
  deletedAt?: unknown;
};

type PropertyDefLike = {
  id: bigint;
  schemaId: bigint;
  name: string;
  order: number;
};

type PropertyValueLike = {
  pageId: bigint;
  propertyDefinitionId: bigint;
  /** Tagged union, e.g. `{ tag: "Select", value: "Done" }`. */
  value: { tag: string; value?: unknown } | undefined;
};

type SchemaLike = {
  id: bigint;
  pageId: bigint;
  parentSchemaId?: bigint | undefined;
};

/**
 * Flatten a live `PropertyValue` to something a template and a predicate can
 * both use. Arrays stay arrays (MultiSelect, Relation, Person) so membership
 * filters work; everything else becomes its scalar.
 */
function plainValue(v: PropertyValueLike["value"]): unknown {
  if (!v) return null;
  const inner = (v as { value?: unknown }).value;
  return inner === undefined ? null : inner;
}

/** Schema ids reachable from `rootSchemaId`, following `parent_schema_id` down. */
export function schemaChainIds(
  schemas: readonly SchemaLike[],
  rootSchemaId: bigint,
  includeDescendants: boolean,
): Set<bigint> {
  const out = new Set<bigint>([rootSchemaId]);
  if (!includeDescendants) return out;
  // Walk children repeatedly — the chain is short, so a fixpoint pass is
  // simpler and safer than assuming depth.
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of schemas) {
      if (s.parentSchemaId != null && out.has(s.parentSchemaId) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return out;
}

type CacheEntry = {
  page: PageLike;
  values: PropertyValueLike[];
  row: RepeaterRow;
};

export class DatabaseRowCache {
  private cache = new Map<bigint, CacheEntry>();

  /**
   * Compose rows for the given database pages, reusing row objects whose inputs
   * are unchanged.
   *
   * @param pages     candidate row pages (children of the database page(s))
   * @param defs      property definitions in scope, for id → name
   * @param valuesFor page id → its value rows
   */
  build(
    pages: readonly PageLike[],
    defs: readonly PropertyDefLike[],
    valuesFor: Map<bigint, PropertyValueLike[]>,
  ): RepeaterRow[] {
    const nameById = new Map<bigint, string>();
    for (const d of defs) nameById.set(d.id, d.name);

    const next = new Map<bigint, CacheEntry>();
    const rows: RepeaterRow[] = [];

    for (const page of pages) {
      const values = valuesFor.get(page.id) ?? EMPTY_VALUES;
      const cached = this.cache.get(page.id);

      const reusable =
        cached !== undefined &&
        cached.page === page &&
        cached.values.length === values.length &&
        values.every((v, i) => v === cached.values[i]);

      if (reusable) {
        next.set(page.id, cached);
        rows.push(cached.row);
        continue;
      }

      const row: Record<string, unknown> = {
        id: page.id,
        parentId: page.parentId ?? null,
        title: page.title,
      };
      for (const v of values) {
        const name = nameById.get(v.propertyDefinitionId);
        // A value whose definition is out of scope (deleted column, or a
        // sibling schema) is skipped rather than exposed under an id.
        if (!name) continue;
        row[name] = plainValue(v.value);
      }
      // Columns with no stored value still appear, as null — otherwise
      // `isEmpty` could not distinguish "blank" from "column does not exist".
      for (const d of defs) {
        if (!(d.name in row)) row[d.name] = null;
      }

      const composed = row as unknown as RepeaterRow;
      next.set(page.id, { page, values, row: composed });
      rows.push(composed);
    }

    this.cache = next;
    return rows;
  }
}

const EMPTY_VALUES: PropertyValueLike[] = [];
