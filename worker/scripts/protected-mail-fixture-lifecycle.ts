/** Only for uniquely named synthetic databases on localhost test servers. */
export function retainFixtureDatabaseUntilServerCleanup(): boolean {
  const value = process.env.PEAR_PROTECTED_MAIL_RETAIN_UNTIL_SERVER_CLEANUP;
  if (value !== undefined && value !== "1") throw new Error("invalid_fixture_retention_mode");
  return value === "1";
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
