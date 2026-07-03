/**
 * `<BlockView>` — ephemeral read-only rendering. Asserts the two properties
 * that make it the custom-view / generative-chat primitive: it renders content
 * with NO editor chrome (no drag grip / insert / block menu), and leaf editors
 * render their static HTML body rather than mounting ProseMirror / IndexedDB.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Y from "yjs";
import { BlockView } from "./BlockView";
import { registerCoreBlocks } from "./registerCoreBlocks";
import { plainTextToYDoc } from "./rich-text/richTextFormatting";
import type {
  BlockNode,
  BlockTree,
  BlockTypeDefinition,
  BlockYjsState,
} from "./types";

registerCoreBlocks();

function yjsFor(text: string): Uint8Array {
  return Y.encodeStateAsUpdate(plainTextToYDoc(text));
}

/** A Heading section (root) owning one RichText child. */
function sampleTree(): BlockTree {
  const heading: BlockNode = {
    id: 1n,
    surfaceId: 0n,
    parentId: null,
    componentType: "Heading",
    props: JSON.stringify({ level: 1, section: true }),
    order: 0,
  };
  const rich: BlockNode = {
    id: 2n,
    surfaceId: 0n,
    parentId: 1n,
    componentType: "RichText",
    props: "{}",
    order: 0,
  };
  const byId = new Map<bigint, BlockNode>([
    [1n, heading],
    [2n, rich],
  ]);
  const byParent = new Map<bigint | null, BlockNode[]>([
    [null, [heading]],
    [1n, [rich]],
  ]);
  const defs = new Map<string, BlockTypeDefinition>([
    ["Heading", { componentType: "Heading", propSchema: "{}", acceptsChildren: true }],
    ["RichText", { componentType: "RichText", propSchema: "{}", acceptsChildren: false }],
  ]);
  const yjs = new Map<bigint, BlockYjsState>([
    [1n, { componentNodeId: 1n, data: yjsFor("My Heading") }],
    [2n, { componentNodeId: 2n, data: yjsFor("hello world") }],
  ]);
  return { root: heading, byId, byParent, defs, yjs, loading: false };
}

describe("BlockView read-only rendering", () => {
  const html = renderToStaticMarkup(
    createElement(BlockView, { tree: sampleTree() }),
  );

  it("renders node content (heading + rich text) from the Yjs blobs", () => {
    expect(html).toContain("My Heading");
    expect(html).toContain("hello world");
  });

  it("renders no editor chrome (drag / insert / block menu)", () => {
    expect(html).not.toContain("data-block-chrome");
    expect(html).not.toContain("data-block-gutter");
  });

  it("mounts no live ProseMirror editor (static path only)", () => {
    expect(html).not.toContain("ProseMirror");
    expect(html.toLowerCase()).not.toContain("contenteditable");
  });
});
