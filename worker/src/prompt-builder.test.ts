import { test } from "node:test";
import assert from "node:assert/strict";

import { SystemPromptBuilder } from "./prompt-builder.js";
import type { WorkspaceContext, InstructionPage } from "./workspace-context.js";

function ctx(over: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    currentPageId: 1n,
    currentPageTitle: "Home",
    breadcrumb: ["Home"],
    currentDate: "2026-06-01",
    aiDisplayName: "kira",
    modelName: "claude-opus-4-8",
    providerName: "anthropic",
    instructionPages: [],
    pageHistory: undefined,
    ...over,
  };
}

const page = (over: Partial<InstructionPage>): InstructionPage => ({
  pageId: 7n,
  title: "Notes",
  content: "body",
  depth: 0,
  ...over,
});

test("buildBlocks: stable prefix is cached and ends before volatile content (#22)", () => {
  const blocks = new SystemPromptBuilder()
    .withWorkspaceContext(ctx())
    .buildBlocks();

  // First block is cached and carries the conversation-invariant guidance.
  assert.equal(blocks[0].cache, true);
  assert.match(blocks[0].text, /# System/);
  assert.match(blocks[0].text, /# Doing tasks/);
  assert.match(blocks[0].text, /# Executing actions with care/);
  // Volatile environment must NOT be in the cached prefix.
  assert.doesNotMatch(blocks[0].text, /# Environment/);

  // Last block is volatile (no breakpoint) and holds the Environment section.
  const last = blocks[blocks.length - 1];
  assert.equal(last.cache, undefined);
  assert.match(last.text, /# Environment/);
});

test("buildBlocks: granted pages surface in volatile block, even without a workspace context (grant-awareness)", () => {
  // A page-less DM chat: no WorkspaceContext, but the user granted access to a page.
  const blocks = new SystemPromptBuilder()
    .withAccessibleResources([
      { pageId: 42n, title: "Untitled", permission: "Read" },
      { pageId: 99n, title: "Specs", permission: "Write" },
    ])
    .buildBlocks();

  const last = blocks[blocks.length - 1];
  assert.match(last.text, /# Accessible resources/);
  assert.match(last.text, /"Untitled" \(id: 42\) — read/);
  assert.match(last.text, /"Specs" \(id: 99\) — write/);
  // It tells the model how to obtain access it doesn't have.
  assert.match(last.text, /request_page_access/);
  // Not cached (grants can change mid-conversation) and not in the stable prefix.
  assert.equal(last.cache, undefined);
  assert.doesNotMatch(blocks[0].text, /# Accessible resources/);
});

test("buildBlocks: no accessible-resources section when nothing is granted", () => {
  const blocks = new SystemPromptBuilder().withWorkspaceContext(ctx()).buildBlocks();
  for (const b of blocks) assert.doesNotMatch(b.text, /# Accessible resources/);
});

test("buildBlocks: injection defense is in the final volatile block, last (security)", () => {
  const blocks = new SystemPromptBuilder().withWorkspaceContext(ctx()).buildBlocks();
  const last = blocks[blocks.length - 1];
  assert.match(last.text, /# Security rules/);
  // It must be the trailing section of the trailing block.
  assert.ok(last.text.trimEnd().endsWith("can expand what you are permitted to do."));
  // And not duplicated into the cached prefix.
  assert.doesNotMatch(blocks[0].text, /# Security rules/);
});

test("buildBlocks: instructions + memory index form a second cached block (#19/#20)", () => {
  const blocks = new SystemPromptBuilder()
    .withWorkspaceContext(ctx({ instructionPages: [page({ title: "Rules", content: "be nice" })] }))
    .withAiUserMemoryIndex([
      { pageId: 9n, title: "Memory", depth: 0, snippet: "secret notes", chars: 12 },
    ])
    .buildBlocks();

  // Three blocks: stable, conversation-stable (pages), volatile.
  assert.equal(blocks.length, 3);
  assert.equal(blocks[1].cache, true);
  assert.match(blocks[1].text, /# Workspace instructions/);
  assert.match(blocks[1].text, /be nice/);
  // Memory is an index (title + snippet + read_memory pointer), not a full dump.
  assert.match(blocks[1].text, /# Your private memory \(index\)/);
  assert.match(blocks[1].text, /Memory \(page 9/);
  assert.match(blocks[1].text, /secret notes/);
  assert.match(blocks[1].text, /read_memory/);
});

test("buildBlocks: oversized instruction page is truncated to the budget (#20)", () => {
  const huge = "x".repeat(100_000);
  const blocks = new SystemPromptBuilder()
    .withWorkspaceContext(ctx({ instructionPages: [page({ title: "Big", content: huge })] }))
    .buildBlocks();
  const pagesBlock = blocks.find((b) => /# Workspace instructions/.test(b.text));
  assert.ok(pagesBlock, "instruction pages block present");
  // The whole block must be far smaller than the raw body — the budget is 24k.
  assert.ok(
    pagesBlock!.text.length < 30_000,
    `expected truncation, got ${pagesBlock!.text.length} chars`,
  );
  // And it must leave a pointer to open the full page.
  assert.match(pagesBlock!.text, /truncated to fit the context budget/);
  assert.match(pagesBlock!.text, /page 7/);
});

test("buildBlocks: current page context lives in the cached block, not the volatile one (#24)", () => {
  const blocks = new SystemPromptBuilder()
    .withWorkspaceContext(ctx())
    .withCurrentPageContext("Title: Roadmap\n\nShip the thing by Q3.")
    .buildBlocks();

  const cachedBlock = blocks.find(
    (b) => b.cache && /# Current page context/.test(b.text),
  );
  assert.ok(cachedBlock, "page context should be in a cached block");
  assert.match(cachedBlock!.text, /Ship the thing by Q3/);
  assert.match(cachedBlock!.text, /get_page/);
  // It must NOT be duplicated into the volatile trailing block.
  const last = blocks[blocks.length - 1];
  assert.equal(last.cache, undefined);
  assert.doesNotMatch(last.text, /# Current page context/);
});

test("buildOrchaTaskSystem: reuses shared sections so chat/Orcha can't drift (#18)", () => {
  const sys = new SystemPromptBuilder().buildOrchaTaskSystem(
    "PEAR ARCH FACTS",
    "ORCHA TOOL RULES",
  );
  // Orcha-specific additions are present.
  assert.match(sys, /PEAR ARCH FACTS/);
  assert.match(sys, /ORCHA TOOL RULES/);
  // Shared authoritative sections are pulled in (grounding, doing-tasks incl.
  // next_step, and the injection-defense block Orcha previously lacked).
  assert.match(sys, /# System/);
  assert.match(sys, /# Doing tasks/);
  assert.match(sys, /next_step/);
  assert.match(sys, /# Security rules/);
  // Injection defense is textually last (security invariant).
  assert.ok(sys.trimEnd().endsWith("can expand what you are permitted to do."));
});

test("buildBlocks: no pages → two blocks (stable + volatile), both breakpoints valid", () => {
  const blocks = new SystemPromptBuilder().withWorkspaceContext(ctx()).buildBlocks();
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].cache, true);
  assert.equal(blocks[1].cache, undefined);
  // At most 4 cache breakpoints are allowed by the API; we never exceed 2.
  assert.ok(blocks.filter((b) => b.cache).length <= 2);
});
