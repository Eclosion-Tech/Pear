"use client";
import { useMemo } from "react";
import type { SlashMenuItem } from "@eclosion-tech/pulp";
import {
  useWorkspaceComponentTemplates,
  useWorkspaceComponentVersions,
} from "@/src/hooks/useComponentRepository";
import { useComponentLibrary } from "./ComponentLibraryProvider";
import {
  PEAR_SLASH_ITEMS,
  workspaceTemplateSlashItems,
} from "./pearSlashItems";

/** Workspace subscriptions enforce discovery authority; insertion rechecks it. */
export function useComponentSlashItems(
  surfaceId: bigint,
  parentId: bigint | null,
): SlashMenuItem[] {
  const { rows: families } = useWorkspaceComponentTemplates();
  const { rows: versions } = useWorkspaceComponentVersions();
  const library = useComponentLibrary();
  return useMemo(
    () => [
      ...PEAR_SLASH_ITEMS,
      ...workspaceTemplateSlashItems(families, versions),
      ...(library
        ? [
            {
              id: "browse-components",
              section: "Components",
              label: "Browse all components…",
              description: "Preview workspace templates and insert one here.",
              componentType: "TrellisPanel",
              defaultProps: {},
              searchTokens: ["component", "template", "library", "browse"],
              choose: ({ insert }: { insert: (item: SlashMenuItem) => void }) =>
                library.open({
                  surfaceId,
                  parentId,
                  onInsert: (descriptor, name) =>
                    insert({
                      id: "selected-template",
                      label: name,
                      description: "Workspace template",
                      componentType: "TrellisPanel",
                      defaultProps: descriptor,
                      searchTokens: [],
                    }),
                }),
            },
          ]
        : []),
    ],
    [families, versions, library, surfaceId, parentId],
  );
}
