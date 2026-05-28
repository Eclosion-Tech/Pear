import {
  convertBlockNoteDocument,
  type BlockNoteBlock,
} from "./blockNoteToComponentTree";

/** Wire format consumed by `migrate_page_to_component_tree` (server). */
export type MigrationPayload = {
  v: "blocknote_migration_v1";
  components: MigrationComponentWire[];
};

export type MigrationComponentWire = {
  sourceBlockId: string;
  parentSourceBlockId: string | null;
  componentType: string;
  propsJson: string;
  yjsDataB64: string | null;
  siblingIndex: number;
};

export function buildMigrationPayload(
  blocks: BlockNoteBlock[],
): MigrationPayload {
  const converted = convertBlockNoteDocument(blocks);
  return {
    v: "blocknote_migration_v1",
    components: converted.map((row) => ({
      sourceBlockId: row.sourceBlockId,
      parentSourceBlockId: row.parentSourceBlockId,
      componentType: row.componentType,
      propsJson: JSON.stringify(row.props),
      yjsDataB64: row.yjsUpdate ? bytesToBase64(row.yjsUpdate) : null,
      siblingIndex: row.siblingIndex,
    })),
  };
}

export function parseBlockNotePageContent(contentJson: string): BlockNoteBlock[] {
  const parsed: unknown = JSON.parse(contentJson);
  if (!Array.isArray(parsed)) {
    throw new Error("PageContent.content is not a BlockNote block array");
  }
  return parsed as BlockNoteBlock[];
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
