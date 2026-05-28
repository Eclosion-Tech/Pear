import { describe, expect, it } from "vitest";
import {
  buildMigrationPayload,
  parseBlockNotePageContent,
} from "./buildMigrationPayload";
import type { BlockNoteBlock } from "./blockNoteToComponentTree";

describe("buildMigrationPayload", () => {
  it("serializes converted blocks for the server reducer", () => {
    const blocks: BlockNoteBlock[] = [
      {
        id: "a",
        type: "bulletListItem",
        content: [{ type: "text", text: "item", styles: {} }],
        children: [],
      },
    ];
    const payload = buildMigrationPayload(blocks);
    expect(payload.v).toBe("blocknote_migration_v1");
    expect(payload.components).toHaveLength(1);
    expect(payload.components[0]).toMatchObject({
      sourceBlockId: "a",
      parentSourceBlockId: null,
      componentType: "BulletListItem",
      propsJson: "{}",
      siblingIndex: 0,
    });
    expect(payload.components[0].yjsDataB64).toBeTruthy();
  });

  it("parses PageContent JSON", () => {
    const blocks = parseBlockNotePageContent(
      JSON.stringify([{ id: "1", type: "paragraph", content: [], children: [] }]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });
});
