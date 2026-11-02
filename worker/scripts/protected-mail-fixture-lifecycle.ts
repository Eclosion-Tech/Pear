/** Only for uniquely named synthetic databases on localhost test servers. */
export function retainFixtureDatabaseUntilServerCleanup(): boolean {
  const value = process.env.PEAR_PROTECTED_MAIL_RETAIN_UNTIL_SERVER_CLEANUP;
  if (value !== undefined && value !== "1") throw new Error("invalid_fixture_retention_mode");
  return value === "1";
}

/** Report fixed failure classes only. Assertion diffs and transport messages
 * can contain fixture bodies, database identities, and bearer credentials. */
export function fixtureFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "operation_failed";
  if (error.name === "TimeoutError" || error.name === "AbortError") return "request_timeout";
  const message = error.message.split(/\r?\n/, 1)[0];
  if (["connection_timeout", "connection_failed", "subscription_timeout",
    "private_subscription_timeout", "fixture_client_shutdown_timeout"].includes(message)) return message;
  const code = (error as Error & { code?: string }).code;
  if (code === "ERR_ASSERTION") return "assertion_failed";
  if (code === "stdb_sql_error") return "sql_failed";
  if (code === "stdb_reducer_error") return "reducer_failed";
  return "operation_failed";
}

/** Cleanup must still fail an otherwise successful fixture, but must never
 * replace the error that made setup or conformance fail in the first place. */
export async function withFixtureCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
  reportSecondaryFailure: () => void,
): Promise<T> {
  let failed = false;
  try {
    return await operation();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await cleanup(); }
    catch (error) {
      if (!failed) throw error;
      try { reportSecondaryFailure(); } catch { /* Preserve the primary failure. */ }
    }
  }
}

/** SDK disconnect() schedules socket closure. Observe native client removal
 * before intentional server shutdown; this is not a durability/crash barrier.
 * The publisher query must target this script's own disposable database. */
export async function drainFixtureConnections(
  connections: Iterable<{ disconnect(): void }>,
  queryClients: () => Promise<readonly unknown[]>,
): Promise<void> {
  for (const connection of connections) connection.disconnect();
  const deadline = Date.now() + 10_000;
  do {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let clients: readonly unknown[];
    try {
      clients = await Promise.race([
        queryClients(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("fixture_client_shutdown_timeout")), Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (clients.length === 0) return;
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("fixture_client_shutdown_timeout");
}
