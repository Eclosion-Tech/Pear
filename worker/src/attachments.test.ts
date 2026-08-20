import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveConversationAttachments } from "./attachments.js";
import { richTextBlockToYjsBytes } from "./rich-text-encode.js";
import type { ConnLike } from "./tools.js";

type NodeRow = {
  id: bigint;
  surfaceId: bigint;
  parentId: bigint | undefined;
  componentType: string;
  props: string;
  order: number;
  deletedAt: unknown;
};

function conn(opts: {
  attachments: Array<Record<string, unknown>>;
  nodes?: NodeRow[];
  yjs?: Array<{ componentNodeId: bigint; data: Uint8Array }>;
  pageContent?: Array<{ pageId: bigint; content: string }>;
}): ConnLike {
  const pageContent = opts.pageContent ?? [];
  return {
    db: {
      conversation_attachment: { iter: () => opts.attachments[Symbol.iterator]() },
      component_node: { iter: () => (opts.nodes ?? [])[Symbol.iterator]() },
      component_yjs_state: { iter: () => (opts.yjs ?? [])[Symbol.iterator]() },
      page_content: { pageId: { find: (id: bigint) => pageContent.find((r) => r.pageId === id) } },
    },
    reducers: {},
  } as unknown as ConnLike;
}

const pageAttachment = (pageId: bigint, snapshot: string | undefined) => ({
  id: 1n,
  messageId: 10n,
  conversationId: 5n,
  kind: { tag: "Page" },
  objectKey: undefined,
  mimeType: undefined,
  fileName: "Roadmap",
  pageId,
  contentSnapshot: snapshot,
});

test("Page attachments read the page's current component-tree body, not the drag-time snapshot", async () => {
  const nodes: NodeRow[] = [
    { id: 100n, surfaceId: 42n, parentId: undefined, componentType: "Container", props: "{}", order: 0, deletedAt: undefined },
    { id: 101n, surfaceId: 42n, parentId: 100n, componentType: "Heading", props: JSON.stringify({ level: 2 }), order: 1000, deletedAt: undefined },
    { id: 102n, surfaceId: 42n, parentId: 101n, componentType: "BulletListItem", props: "{}", order: 1000, deletedAt: undefined },
  ];
  const yjs = [
    { componentNodeId: 101n, data: richTextBlockToYjsBytes("Q3", true) },
    { componentNodeId: 102n, data: richTextBlockToYjsBytes("ship files", true) },
  ];
  const c = conn({ attachments: [pageAttachment(42n, "")], nodes, yjs });
  const resolved = await resolveConversationAttachments(c, 5n, "[t]");
  const ctx = resolved.get(10n)!.contextText;
  assert.match(ctx, /Attached page "Roadmap" \(page 42\), current content/);
  assert.match(ctx, /## Q3\n\n- ship files/);
});

test("Page attachments fall back to the snapshot, then legacy page_content", async () => {
  const withSnapshot = conn({ attachments: [pageAttachment(7n, "frozen text")] });
  const a = await resolveConversationAttachments(withSnapshot, 5n, "[t]");
  assert.match(a.get(10n)!.contextText, /snapshot at attach time/);
  assert.match(a.get(10n)!.contextText, /frozen text/);

  const legacy = conn({ attachments: [pageAttachment(8n, "")], pageContent: [{ pageId: 8n, content: "blocknote body" }] });
  const b = await resolveConversationAttachments(legacy, 5n, "[t]");
  assert.match(b.get(10n)!.contextText, /current content/);
  assert.match(b.get(10n)!.contextText, /blocknote body/);

  const nothing = conn({ attachments: [pageAttachment(9n, undefined)] });
  const n = await resolveConversationAttachments(nothing, 5n, "[t]");
  assert.match(n.get(10n)!.contextText, /no content captured/);
});
