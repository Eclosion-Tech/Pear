import { tables } from "./module_bindings/index.js";

type SubscriptionBuilderLike = {
  onApplied(cb: () => void): SubscriptionBuilderLike;
  onError(cb: (_ctx: unknown, err: unknown) => void): SubscriptionBuilderLike;
  subscribe(queries: string[]): unknown;
};

type ConnectionLike = {
  subscriptionBuilder(): SubscriptionBuilderLike;
};

type TableRefLike = {
  sourceName?: string;
  tableDef?: {
    sourceName?: string;
  };
};

const ALL_TABLE_NAMES = Object.values(tables as Record<string, TableRefLike>)
  .map((table) => table.sourceName ?? table.tableDef?.sourceName)
  .filter((name): name is string => Boolean(name));

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function missingTableName(err: unknown): string | undefined {
  const match = errorMessage(err).match(/no such table:\s*`([^`]+)`/);
  return match?.[1];
}

// Tables whose live INSERT/UPDATE delivery the request/response bridge flow
// depends on (the worker enqueues a command then waits to see the row + its
// result appear). These get their OWN subscription, isolated from the large
// bundle below: a single bad/By-changed query in a ~60-table bundle can leave
// the whole subscription delivering only its initial snapshot (no incrementals),
// which silently breaks the bridge poll loop. An isolated subscription can't be
// degraded by an unrelated table.
const BRIDGE_TABLE_NAMES = [
  "bridge_command",
  "bridge_command_result",
  "bridge_device_summary",
  "bridge_device_grant",
  "bridge_device_allowlist",
  "bridge_device_capability",
  "bridge_command_chunk",
];

// Provider instances contain credential-bearing clients and are cached between
// turns. API-key/config rotations must therefore arrive as live updates. Keep
// this table on an isolated query set: the large all-table subscription can
// still apply its initial snapshot while silently losing incrementals when an
// unrelated query is degraded.
const AI_CONFIG_TABLE_NAMES = ["ai_user_config"];

export function subscribeToAvailableTables(
  conn: unknown,
  logTag: string,
  onApplied: () => void,
): void {
  const connection = conn as ConnectionLike;
  const skipped = new Set<string>();

  const subscribe = (): void => {
    const queries = ALL_TABLE_NAMES.filter((name) => !skipped.has(name)).map(
      (name) => `SELECT * FROM ${name}`,
    );

    if (queries.length === 0) {
      console.error(`${logTag} subscription error: no available tables to subscribe to`);
      return;
    }

    connection
      .subscriptionBuilder()
      .onApplied(onApplied)
      .onError((_ctx: unknown, err: unknown) => {
        const missing = missingTableName(err);
        if (missing && !skipped.has(missing)) {
          skipped.add(missing);
          console.warn(
            `${logTag} subscription skipped missing table "${missing}" and is retrying`,
          );
          subscribe();
          return;
        }

        console.error(`${logTag} subscription error:`, errorMessage(err));
      })
      .subscribe(queries);
  };

  subscribe();
  subscribeIsolatedTables(connection, logTag, "bridge", BRIDGE_TABLE_NAMES);
  subscribeIsolatedTables(connection, logTag, "AI config", AI_CONFIG_TABLE_NAMES);
}

/**
 * Subscribe a small group separately from the main bundle so its realtime
 * INSERT/UPDATE delivery is never degraded by an unrelated query. Each
 * available table is subscribed; a missing one (older module) is skipped.
 */
function subscribeIsolatedTables(
  connection: ConnectionLike,
  logTag: string,
  label: string,
  tableNames: readonly string[],
): void {
  const present = new Set(ALL_TABLE_NAMES);
  const skipped = new Set<string>();

  const subscribe = (): void => {
    const queries = tableNames.filter(
      (name) => present.has(name) && !skipped.has(name),
    ).map((name) => `SELECT * FROM ${name}`);
    if (queries.length === 0) return;

    connection
      .subscriptionBuilder()
      .onApplied(() => console.log(`${logTag} ${label} subscription ready`))
      .onError((_ctx: unknown, err: unknown) => {
        const missing = missingTableName(err);
        if (missing && !skipped.has(missing)) {
          skipped.add(missing);
          subscribe();
          return;
        }
        console.error(`${logTag} ${label} subscription error:`, errorMessage(err));
      })
      .subscribe(queries);
  };

  subscribe();
}
