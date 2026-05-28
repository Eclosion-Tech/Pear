import type { BlockTypeDefinition } from "./types";
import type { SlashMenuItem } from "./SlashMenu";
import { SPRINT_3B_SLASH_ITEMS } from "./SlashMenu";

/** Block types exposed on the selection toolbar type dropdown. */
const TURN_INTO_COMPONENT_TYPES = new Set([
  "RichText",
  "Heading",
  "BulletListItem",
  "NumberedListItem",
  "ChecklistItem",
]);

export function turnIntoToolbarItems(
  items: SlashMenuItem[] | undefined,
  defs: Map<string, BlockTypeDefinition>,
): SlashMenuItem[] {
  const source = items ?? SPRINT_3B_SLASH_ITEMS;
  return source.filter(
    (item) =>
      TURN_INTO_COMPONENT_TYPES.has(item.componentType) &&
      defs.has(item.componentType),
  );
}

export function labelForBlock(
  componentType: string,
  propsJson: string,
  items: SlashMenuItem[],
): string {
  if (componentType === "Heading") {
    const level = safeParseProps(propsJson).level;
    const match = items.find(
      (item) =>
        item.componentType === "Heading" &&
        item.defaultProps.level === level,
    );
    return match?.label ?? `Heading ${typeof level === "number" ? level : 1}`;
  }

  const match = items.find((item) => item.componentType === componentType);
  return match?.label ?? componentType;
}

function safeParseProps(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
