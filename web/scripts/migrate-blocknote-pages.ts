/**
 * BlockNote → ComponentTree batch migrator.
 *
 * Walks every live `BlockNote`-format page in a workspace, converts
 * `PageContent.content` via `@eclosion-tech/pulp`, and calls
 * `migrate_page_to_component_tree` atomically per page.
 *
 * Usage:
 *   pnpm --filter web migrate-blocknote <db-name> [<uri>] [flags]
 *
 * Flags:
 *   --dry-run       Parse and report only; no reducer calls
 *   --page-id <id>  Migrate a single page (bigint)
 *
 * Examples:
 *   pnpm --filter web migrate-blocknote pear-dev ws://localhost:3000 --dry-run
 *   SPACETIMEDB_TOKEN=eyJ… pnpm --filter web migrate-blocknote eclosion wss://eclosion.cloud.pear.pro
 *
 * Requires module >= 0.11.6. Run against dev/staging first.
 */

import {
  buildMigrationPayload,
  parseBlockNotePageContent,
} from "@eclosion-tech/pulp";
import type { DbConnection as DbConnectionType } from "../src/module_bindings/index.js";
import { DbConnection } from "../src/module_bindings/index.js";
import type { Page, PageContent } from "../src/module_bindings/types.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const pageIdFlagIdx = argv.indexOf("--page-id");
const singlePageId =
  pageIdFlagIdx >= 0 ? BigInt(argv[pageIdFlagIdx + 1] ?? "") : null;
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && !(pageIdFlagIdx >= 0 && i === pageIdFlagIdx + 1),
);
const db = positional[0];
const uri = positional[1] ?? "ws://localhost:3000";
const token = process.env.SPACETIMEDB_TOKEN?.trim() || undefined;

if (!db) {
  console.error(
    "Usage: pnpm --filter web migrate-blocknote <db-name> [<uri>] [--dry-run] [--page-id <id>]",
  );
  process.exit(1);
}

type AnyDb = Record<string, { iter(): Iterable<unknown> }>;
type AnyReducers = Record<string, (...args: unknown[]) => Promise<unknown>>;

function rows<T>(conn: DbConnectionType, table: string): T[] {
  const t = (conn.db as unknown as AnyDb)[table];
  if (!t) throw new Error(`No such table: ${table}`);
  return Array.from(t.iter()) as T[];
}

function callReducer(
  conn: DbConnectionType,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const fn = (conn.reducers as unknown as AnyReducers)[name];
  if (!fn) throw new Error(`No such reducer: ${name} (publish module >= 0.11.6?)`);
  return fn(args);
}

function isBlockNotePage(page: Page): boolean {
  return page.contentFormat?.tag === "BlockNote" && page.deletedAt == null;
}

async function main(): Promise<void> {
  console.log(
    `[migrate] ${dryRun ? "DRY RUN — " : ""}Connecting to ${uri} / ${db}`,
  );

  const conn: DbConnectionType = await new Promise((resolve, reject) => {
    const builder = DbConnection.builder().withUri(uri).withDatabaseName(db);
    if (token) builder.withToken(token);
    builder
      .onConnect((c, identity) => {
        console.log(`[migrate] Connected as ${identity.toHexString()}`);
        resolve(c);
      })
      .onConnectError((_ctx, err) => reject(new Error(String(err.message))))
      .build();
  });

  await new Promise<void>((resolve, reject) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError((ctx) => {
        const err = (ctx as { event?: { error?: Error } }).event?.error;
        reject(new Error(err?.message ?? "subscription error"));
      })
      .subscribe(["SELECT * FROM page", "SELECT * FROM page_content"]);
  });

  const pages = rows<Page>(conn, "page");
  const contents = rows<PageContent>(conn, "page_content");
  const contentByPage = new Map(contents.map((c) => [c.pageId, c]));

  let targets = pages.filter(isBlockNotePage);
  if (singlePageId != null) {
    targets = targets.filter((p) => p.id === singlePageId);
    if (targets.length === 0) {
      console.error(`[migrate] No BlockNote page with id ${singlePageId}`);
      process.exit(1);
    }
  }

  console.log(`[migrate] Found ${targets.length} BlockNote page(s) to migrate`);

  let ok = 0;
  let skip = 0;
  let fail = 0;

  for (const page of targets) {
    const label = `"${page.title}" (${page.id})`;
    const pc = contentByPage.get(page.id);
    if (!pc?.content?.trim()) {
      console.log(`[migrate] SKIP ${label} — empty PageContent`);
      skip += 1;
      continue;
    }

    let blocks;
    try {
      blocks = parseBlockNotePageContent(pc.content);
    } catch (e) {
      console.error(`[migrate] FAIL ${label} — invalid JSON: ${e}`);
      fail += 1;
      continue;
    }

    const payload = buildMigrationPayload(blocks);
    const typeCounts = payload.components.reduce<Record<string, number>>(
      (acc, c) => {
        acc[c.componentType] = (acc[c.componentType] ?? 0) + 1;
        return acc;
      },
      {},
    );

    console.log(
      `[migrate] ${dryRun ? "PLAN" : "GO"} ${label} — ${payload.components.length} component(s)`,
      typeCounts,
    );

    if (dryRun) {
      ok += 1;
      continue;
    }

    try {
      await callReducer(conn, "migratePageToComponentTree", {
        pageId: page.id,
        payloadJson: JSON.stringify(payload),
      });
      ok += 1;
      console.log(`[migrate] OK ${label}`);
    } catch (e) {
      fail += 1;
      console.error(`[migrate] FAIL ${label}: ${e}`);
    }
  }

  console.log(
    `[migrate] Done — ok=${ok} skip=${skip} fail=${fail}${dryRun ? " (dry run)" : ""}`,
  );
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
