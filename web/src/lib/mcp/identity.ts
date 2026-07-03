/**
 * Token → AI-user resolution.
 *
 * `ai_user_config` is the ONE table with row-level security in scope
 * (`SELECT * FROM ai_user_config WHERE identity = :sender`, ai/mod.rs), so a
 * `/sql` read with the caller's token returns exactly the caller's own row —
 * making this both the identity lookup AND the authentication check: a valid
 * SpacetimeDB token that isn't a Pear AI user gets zero rows.
 */

import type { StdbTransport } from "../api-endpoint";
import { McpAuthError } from "./types";

export async function resolveAiUser(transport: StdbTransport): Promise<bigint> {
  const rows = await transport.sql<{ id: number | string }>(
    "SELECT id FROM ai_user_config",
  );
  const id = rows[0]?.id;
  if (id === undefined || id === null) {
    throw new McpAuthError(
      "This token does not belong to a Pear AI user — no ai_user_config row is " +
        "visible on this connection. Provision one with `pnpm mcp:provision` and " +
        "use the printed worker token.",
    );
  }
  return BigInt(id);
}
