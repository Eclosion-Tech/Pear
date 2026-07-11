import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RLS_SQL_TABLES,
  SUBSCRIPTION_TABLES,
  assertSnapshotCountsMatch,
  parseSqlJson,
  reencodeSqlTableRows,
  reencodeSqlValue,
  snakeToCamel,
  type SqlStatementResult,
} from "./snapshot.js";
import { SNAPSHOT_TABLES_V2 } from "../../packages/snapshot-core/src/index.js";

// Fixture fragments below are captured from a live SpacetimeDB 2.0.3
// `POST /v1/database/{db}/sql` response (local pear-v2-e2e), and the expected
// outputs are what `encodePearValue` produced for the same rows read via a
// subscription — the two paths were diffed byte-identical across 105 rows.

// ── Table partition sanity ───────────────────────────────────────────────────

test("RLS + subscription tables partition the include list exactly", () => {
  assert.equal(RLS_SQL_TABLES.length, 6);
  for (const t of RLS_SQL_TABLES) {
    assert.ok(SNAPSHOT_TABLES_V2.includes(t), `${t} must be in the include list`);
    assert.ok(!SUBSCRIPTION_TABLES.includes(t), `${t} must not be subscribed`);
  }
  assert.equal(SUBSCRIPTION_TABLES.length + RLS_SQL_TABLES.length, SNAPSHOT_TABLES_V2.length);
});

// ── snakeToCamel ─────────────────────────────────────────────────────────────

test("snakeToCamel matches the SDK codegen field naming", () => {
  assert.equal(snakeToCamel("created_at"), "createdAt");
  assert.equal(snakeToCamel("cache_creation_input_tokens"), "cacheCreationInputTokens");
  assert.equal(snakeToCamel("id"), "id");
});

// ── Scalar re-encoding ───────────────────────────────────────────────────────

test("64-bit ints always re-encode as tagged bigints; smaller ints as numbers", () => {
  assert.deepEqual(reencodeSqlValue({ U64: [] }, 1234, "t"), { __pear: "bigint", v: "1234" });
  assert.deepEqual(reencodeSqlValue({ I64: [] }, -5, "t"), { __pear: "bigint", v: "-5" });
  assert.deepEqual(reencodeSqlValue({ U64: [] }, 9007199254740993n, "t"), {
    __pear: "bigint",
    v: "9007199254740993",
  });
  // u128/u256 columns serialize as hex strings.
  assert.deepEqual(reencodeSqlValue({ U128: [] }, "0xff", "t"), { __pear: "bigint", v: "255" });
  assert.equal(reencodeSqlValue({ U32: [] }, 1000, "t"), 1000);
  assert.equal(reencodeSqlValue({ I8: [] }, -3, "t"), -3);
  assert.equal(reencodeSqlValue({ F64: [] }, 1.5, "t"), 1.5);
  assert.equal(reencodeSqlValue({ String: [] }, "hi", "t"), "hi");
  assert.equal(reencodeSqlValue({ Bool: [] }, true, "t"), true);
});

test("unsafe integer without BigInt source access throws instead of corrupting", () => {
  // 2^53 + 2 survives JSON.parse as an (imprecise) plain number.
  assert.throws(
    () => reencodeSqlValue({ U64: [] }, 9007199254740994, "t"),
    /MAX_SAFE_INTEGER/,
  );
});

// ── Special product types ────────────────────────────────────────────────────

test("Identity products re-encode as __pear identity, zero-padded to 32 bytes", () => {
  const identityType = {
    Product: { elements: [{ name: { some: "__identity__" }, algebraic_type: { U256: [] } }] },
  };
  // /sql drops leading zero nibbles; the SDK's toHexString() pads them.
  assert.deepEqual(
    reencodeSqlValue(identityType, ["0x79caff8192d5371116533f10bb3f806bd2d9b253950d11b7a2146a6cd9e00c2"], "t"),
    { __pear: "identity", v: "079caff8192d5371116533f10bb3f806bd2d9b253950d11b7a2146a6cd9e00c2" },
  );
});

test("Timestamp and TimeDuration products re-encode to their __pear tags", () => {
  const tsType = {
    Product: {
      elements: [
        { name: { some: "__timestamp_micros_since_unix_epoch__" }, algebraic_type: { I64: [] } },
      ],
    },
  };
  assert.deepEqual(reencodeSqlValue(tsType, [1783790679306661], "t"), {
    __pear: "timestamp",
    v: "1783790679306661",
  });

  const durType = {
    Product: {
      elements: [{ name: { some: "__time_duration_micros__" }, algebraic_type: { I64: [] } }],
    },
  };
  assert.deepEqual(reencodeSqlValue(durType, [3600000000], "t"), {
    __pear: "bigint",
    v: "3600000000",
  });
});

// ── Options ──────────────────────────────────────────────────────────────────

const optionU64 = {
  Sum: {
    variants: [
      { name: { some: "some" }, algebraic_type: { U64: [] } },
      { name: { some: "none" }, algebraic_type: { Product: { elements: [] } } },
    ],
  },
};

test("Option some/none: value or undefined (key omitted from row objects)", () => {
  assert.deepEqual(reencodeSqlValue(optionU64, [0, 42], "t"), { __pear: "bigint", v: "42" });
  assert.equal(reencodeSqlValue(optionU64, [1, []], "t"), undefined);
});

// ── Named-variant sums ───────────────────────────────────────────────────────

test("named-variant sums re-encode to the SDK's { tag, value } shape", () => {
  // page.page_type — unit variants carry an empty product ⇒ value: {}.
  const pageType = {
    Sum: {
      variants: [
        { name: { some: "doc" }, algebraic_type: { Product: { elements: [] } } },
        { name: { some: "database" }, algebraic_type: { Product: { elements: [] } } },
      ],
    },
  };
  assert.deepEqual(reencodeSqlValue(pageType, [0, []], "t"), { tag: "Doc", value: {} });

  // page.created_by — payload variant, camelCase variant name pascalized.
  const createdBy = {
    Sum: {
      variants: [
        { name: { some: "human" }, algebraic_type: { Product: { elements: [] } } },
        { name: { some: "agent" }, algebraic_type: { String: [] } },
      ],
    },
  };
  assert.deepEqual(reencodeSqlValue(createdBy, [1, "scribe"], "t"), {
    tag: "Agent",
    value: "scribe",
  });

  // ScheduleAt (ai_user_routine.scheduled_at) — Interval carries a TimeDuration.
  const scheduleAt = {
    Sum: {
      variants: [
        {
          name: { some: "Interval" },
          algebraic_type: {
            Product: {
              elements: [
                { name: { some: "__time_duration_micros__" }, algebraic_type: { I64: [] } },
              ],
            },
          },
        },
        {
          name: { some: "Time" },
          algebraic_type: {
            Product: {
              elements: [
                {
                  name: { some: "__timestamp_micros_since_unix_epoch__" },
                  algebraic_type: { I64: [] },
                },
              ],
            },
          },
        },
      ],
    },
  };
  assert.deepEqual(reencodeSqlValue(scheduleAt, [0, [60000000]], "t"), {
    tag: "Interval",
    value: { __pear: "bigint", v: "60000000" },
  });
  assert.deepEqual(reencodeSqlValue(scheduleAt, [1, [1783790679306661]], "t"), {
    tag: "Time",
    value: { __pear: "timestamp", v: "1783790679306661" },
  });
});

// ── Arrays ───────────────────────────────────────────────────────────────────

test("Array<U8> hex string re-encodes as __pear bytes (base64)", () => {
  // Captured from component_yjs_state.data.
  assert.deepEqual(reencodeSqlValue({ Array: { U8: [] } }, "07060504030201", "t"), {
    __pear: "bytes",
    v: Buffer.from("07060504030201", "hex").toString("base64"),
  });
  assert.throws(() => reencodeSqlValue({ Array: { U8: [] } }, "zz", "t"), /not a hex string/);
});

test("non-byte arrays recurse per element", () => {
  assert.deepEqual(reencodeSqlValue({ Array: { F32: [] } }, [0.5, 1.5], "t"), [0.5, 1.5]);
  assert.deepEqual(reencodeSqlValue({ Array: { U64: [] } }, [1, 2], "t"), [
    { __pear: "bigint", v: "1" },
    { __pear: "bigint", v: "2" },
  ]);
});

// ── Whole-row re-encoding (captured user-table fixture) ─────────────────────

test("reencodeSqlTableRows rebuilds the subscription encoding of a user row", () => {
  const result: SqlStatementResult = {
    schema: {
      elements: [
        {
          name: { some: "identity" },
          algebraic_type: {
            Product: {
              elements: [{ name: { some: "__identity__" }, algebraic_type: { U256: [] } }],
            },
          },
        },
        { name: { some: "name" }, algebraic_type: { String: [] } },
        { name: { some: "email" }, algebraic_type: { String: [] } },
        { name: { some: "is_authenticated" }, algebraic_type: { Bool: [] } },
        {
          name: { some: "created_at" },
          algebraic_type: {
            Product: {
              elements: [
                {
                  name: { some: "__timestamp_micros_since_unix_epoch__" },
                  algebraic_type: { I64: [] },
                },
              ],
            },
          },
        },
        { name: { some: "is_admin" }, algebraic_type: { Bool: [] } },
      ],
    },
    rows: [
      [
        ["0xc200bc5cf9c6d56c13ff3d686d7ce89f5e434b8af08f33982eca45332c3c64f5"],
        "Snapshot E2E",
        "e2e@example.test",
        true,
        [1783791079670499],
        true,
      ],
    ],
  };

  assert.deepEqual(reencodeSqlTableRows(result, "user"), [
    {
      identity: {
        __pear: "identity",
        v: "c200bc5cf9c6d56c13ff3d686d7ce89f5e434b8af08f33982eca45332c3c64f5",
      },
      name: "Snapshot E2E",
      email: "e2e@example.test",
      isAuthenticated: true,
      createdAt: { __pear: "timestamp", v: "1783791079670499" },
      isAdmin: true,
    },
  ]);
});

test("option-none columns are omitted from re-encoded rows (matches JSON export)", () => {
  const result: SqlStatementResult = {
    schema: {
      elements: [
        { name: { some: "id" }, algebraic_type: { U64: [] } },
        { name: { some: "parent_id" }, algebraic_type: optionU64 },
      ],
    },
    rows: [
      [7, [1, []]],
      [8, [0, 7]],
    ],
  };
  const rows = reencodeSqlTableRows(result, "page");
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { id: { __pear: "bigint", v: "7" } },
    { id: { __pear: "bigint", v: "8" }, parentId: { __pear: "bigint", v: "7" } },
  ]);
  assert.ok(!("parentId" in rows[0]));
});

test("malformed sum/product values throw instead of producing partial rows", () => {
  assert.throws(() => reencodeSqlValue(optionU64, [5, 42], "t"), /out of range/);
  assert.throws(() => reencodeSqlValue(optionU64, "nope", "t"), /variantIndex/);
  assert.throws(
    () =>
      reencodeSqlValue(
        { Product: { elements: [{ name: { some: "a" }, algebraic_type: { U64: [] } }] } },
        [1, 2],
        "t",
      ),
    /product of 1/,
  );
});

// ── parseSqlJson ─────────────────────────────────────────────────────────────

test("parseSqlJson keeps unsafe integers exact as BigInt, safe ones as numbers", () => {
  const parsed = parseSqlJson('{"small": 42, "big": 9007199254740993, "f": 1.5}') as Record<
    string,
    unknown
  >;
  assert.equal(parsed.small, 42);
  assert.equal(parsed.f, 1.5);
  // Node ≥ 21 exposes reviver source text (deploys run node 22). On older
  // runtimes parseSqlJson degrades to plain JSON.parse and the re-encoder
  // throws before an imprecise value can reach a snapshot.
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 21) {
    assert.equal(parsed.big, 9007199254740993n);
  }
});

// ── Completeness cross-check ─────────────────────────────────────────────────

function allCounts(n: number): Record<string, number> {
  return Object.fromEntries(SNAPSHOT_TABLES_V2.map((t) => [t, n]));
}

test("assertSnapshotCountsMatch passes on identical counts", () => {
  assertSnapshotCountsMatch(allCounts(3), allCounts(3));
});

test("assertSnapshotCountsMatch throws loudly on any mismatch", () => {
  const snapshot = allCounts(3);
  const sql = allCounts(3);
  sql.message_feedback = 4;
  assert.throws(
    () => assertSnapshotCountsMatch(snapshot, sql),
    /message_feedback: snapshot=3 sql=4/,
  );

  const missing = allCounts(3);
  delete missing.user;
  assert.throws(() => assertSnapshotCountsMatch(missing, allCounts(3)), /user: snapshot=missing/);
});
