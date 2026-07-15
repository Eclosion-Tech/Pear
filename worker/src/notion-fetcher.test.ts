import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchNotionWorkspace } from "./notion/fetcher.js";
import type { Client } from "@notionhq/client";

/**
 * Fetch-side regression tests via a stubbed Notion client: pagination loops
 * (search, comments), 25-item property completion, and synced-block grafting.
 * Each stub response mirrors the real API's shape for the fields we read.
 */

function fullPage(id: string, extraProps: Record<string, unknown> = {}) {
  return {
    object: "page", id,
    parent: { type: "workspace", workspace: true },
    created_time: "2026-07-15T00:00:00.000Z",
    last_edited_time: "2026-07-15T00:00:00.000Z",
    archived: false, in_trash: false,
    icon: null, cover: null, url: `https://notion.so/${id}`,
    properties: {
      Name: { type: "title", id: "title", title: [] },
      ...extraProps,
    },
  };
}

function makeStub() {
  const relationRefs = Array.from({ length: 60 }, (_, i) => ({ id: `rel-${i}` }));
  const comments = Array.from({ length: 150 }, (_, i) => ({
    object: "comment", id: `c-${i}`,
    rich_text: [{ type: "text", plain_text: `comment ${i}`, text: { content: "", link: null }, annotations: {} }],
    created_time: "2026-07-15T00:00:00.000Z",
  }));

  const calls: Record<string, number> = {};
  const count = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; };

  const stub = {
    search: async (args: { filter: { value: string }; start_cursor?: string }) => {
      count(`search:${args.filter.value}`);
      if (args.filter.value === "page") {
        // Two pages of results to exercise the cursor loop.
        return args.start_cursor
          ? { results: [fullPage("p2", {
              Links: { type: "relation", id: "rl", relation: relationRefs.slice(0, 25), has_more: true },
            })], has_more: false, next_cursor: null }
          : { results: [fullPage("p1")], has_more: true, next_cursor: "cur-1" };
      }
      return { results: [], has_more: false, next_cursor: null };
    },
    dataSources: { query: async () => ({ results: [], has_more: false, next_cursor: null }) },
    pages: {
      properties: {
        retrieve: async (args: { page_id: string; property_id: string; start_cursor?: string }) => {
          count("prop-item");
          const start = args.start_cursor ? 50 : 0;
          const slice = relationRefs.slice(start, start + 50);
          return {
            object: "list",
            results: slice.map((r) => ({ type: "relation", relation: r })),
            has_more: start + 50 < relationRefs.length,
            next_cursor: start + 50 < relationRefs.length ? "next" : null,
          };
        },
      },
    },
    users: {
      list: async () => ({
        results: [{ object: "user", id: "u-1", name: "Jenna" }],
        has_more: false, next_cursor: null,
      }),
    },
    blocks: {
      children: {
        list: async (args: { block_id: string }) => {
          count(`blocks:${args.block_id}`);
          if (args.block_id === "p1") {
            return {
              results: [{
                object: "block", id: "sync-dup", type: "synced_block", has_children: false,
                parent: { type: "page_id", page_id: "p1" }, archived: false, in_trash: false,
                synced_block: { synced_from: { type: "block_id", block_id: "sync-orig" } },
              }],
              has_more: false, next_cursor: null,
            };
          }
          if (args.block_id === "sync-orig") {
            return {
              results: [{
                object: "block", id: "orig-child", type: "paragraph", has_children: false,
                parent: { type: "block_id", block_id: "sync-orig" }, archived: false, in_trash: false,
                paragraph: { rich_text: [], color: "default" },
              }],
              has_more: false, next_cursor: null,
            };
          }
          return { results: [], has_more: false, next_cursor: null };
        },
      },
    },
    comments: {
      list: async (args: { block_id: string; start_cursor?: string }) => {
        count("comments");
        if (args.block_id !== "p1") return { results: [], has_more: false, next_cursor: null };
        const start = args.start_cursor ? 100 : 0;
        return {
          results: comments.slice(start, start + 100),
          has_more: start + 100 < comments.length,
          next_cursor: start + 100 < comments.length ? "more" : null,
        };
      },
    },
  };
  return { stub: stub as unknown as Client, calls };
}

test("fetcher pages search results, completes 25-item properties, paginates comments, grafts synced blocks", async () => {
  const { stub, calls } = makeStub();
  const result = await fetchNotionWorkspace("fake-token", undefined, stub);

  // Search pagination: both pages found across two cursor rounds.
  assert.ok(result.pages.has("p1") && result.pages.has("p2"), "both search pages fetched");
  assert.equal(calls["search:page"], 2, "search followed the cursor");

  // Property completion: p2's relation had 25 inline refs + has_more; the
  // property-item endpoint pages to the full 60.
  const p2 = result.pages.get("p2") as { properties: { Links: { relation: unknown[] } } };
  assert.equal(p2.properties.Links.relation.length, 60, "truncated relation completed");
  assert.ok((calls["prop-item"] ?? 0) >= 2, "property-item endpoint paginated");

  // Comments pagination: all 150 comments survive.
  assert.equal(result.comments.get("p1")?.length, 150, "comments paginated past 100");

  // Synced-block grafting: the original's child rides under the duplicate.
  const p1Blocks = result.blocks.get("p1") ?? [];
  const grafted = p1Blocks.find((b) => b.id === "orig-child");
  assert.ok(grafted, "original synced content grafted");
  assert.equal(
    (grafted!.parent as { block_id?: string }).block_id,
    "sync-dup",
    "grafted child reparented under the duplicate",
  );

  // User directory captured.
  assert.equal(result.userNames.get("u-1"), "Jenna");
});
