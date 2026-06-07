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
  /** Open a block-anchored thread (from a gutter marker) in the AI panel. */
  onOpenThread?: (conversationId: bigint) => void;
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
  onOpenThread,
  editorKeySuffix = "",
}: PageEditorSurfaceProps) {
  const migration = useMigrateBlockNotePageOnOpen(page, content?.content);

  if (migration.showComponentTree) {
    // `key` forces a fresh editor instance per page. Without it, navigating
    // between ComponentTree pages reuses ComponentTreeRenderer's instance state
    // — focus/undo coordinators (created once via useRef) and any in-flight
    // optimistic blocks — which could carry one page's content/undo stack onto
    // another. The PearEditor path below is keyed for the same reason.
    return (
      <ComponentTreeRenderer
        key={`${page.id}-${editorKeySuffix}`}
        surfaceId={page.id}
        onOpenThread={onOpenThread}
      />
    );
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
