"use client";

import type { PageContent } from "@/src/module_bindings/types";
import type { PageRow } from "@/src/hooks/usePages";
import { useMigrateBlockNotePageOnOpen } from "@/src/hooks/useMigrateBlockNotePageOnOpen";
import { ComponentTreeRenderer } from "./component-renderers";
import { PageMigratingShell } from "./PageMigratingShell";
import { PearEditor } from "./PearEditor";

export type PageEditorSurfaceProps = {
  page: PageRow;
  content: PageContent | undefined;
  childPages?: PageRow[];
  onMentionAiUser?: () => void;
  /** PearEditor remount key — e.g. content updatedAt in modals. */
  editorKeySuffix?: string | number;
};

/**
 * Doc body: ComponentTree when migrated, lazy-migrate BlockNote on first
 * open, fall back to PearEditor if migration is disabled or fails.
 */
export function PageEditorSurface({
  page,
  content,
  childPages,
  onMentionAiUser,
  editorKeySuffix = "",
}: PageEditorSurfaceProps) {
  const migration = useMigrateBlockNotePageOnOpen(page, content?.content);

  if (migration.showComponentTree) {
    return <ComponentTreeRenderer surfaceId={page.id} />;
  }

  if (migration.showMigrating) {
    return (
      <PageMigratingShell error={migration.error} onRetry={migration.retry} />
    );
  }

  if (migration.showPearEditor) {
    return (
      <PearEditor
        key={`${page.id}-${editorKeySuffix}`}
        pageId={page.id}
        initialContent={content?.content ?? ""}
        initialContentUpdatedAt={content?.updatedAt?.microsSinceUnixEpoch}
        childPages={childPages}
        onMentionAiUser={onMentionAiUser}
      />
    );
  }

  return <PageMigratingShell />;
}
