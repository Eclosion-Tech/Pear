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
}
