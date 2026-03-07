"use client";

import { useState, useRef, useEffect } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { useUpdatePageTitle } from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import { PearEditor } from "./PearEditor";

interface DocPageProps {
  page: PageRow;
}

export function DocPage({ page }: DocPageProps) {
  const updateTitle = useUpdatePageTitle();
  const [contents] = useTable(tables.page_content);
  const content = contents.find((c) => c.pageId === page.id);

  const [title, setTitle] = useState(page.title);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether the title input is focused so we can ignore server echoes
  // that would overwrite characters the user is still typing.
  const titleFocusedRef = useRef(false);

  useEffect(() => {
    // Only sync the title from the server when the user is not editing it.
    // Without this guard, SpacetimeDB echoes our own debounced saves back and
    // the arriving subscription update overwrites newer locally-typed characters.
    if (!titleFocusedRef.current) {
      setTitle(page.title);
    }
  }, [page.title]);

  async function handleTitleChange(value: string) {
    setTitle(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if (value.trim()) await updateTitle({ pageId: page.id, title: value });
    }, 400);
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto w-full px-8 pt-16 pb-24">
        <input
          className="text-4xl font-bold text-neutral-900 dark:text-white bg-transparent outline-none w-full mb-6 placeholder:text-neutral-300 dark:placeholder:text-neutral-700"
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          onFocus={() => { titleFocusedRef.current = true; }}
          onBlur={() => {
            titleFocusedRef.current = false;
            // On blur, snap to the latest server value so we stay in sync
            // (handles the case where focus leaves before the echo arrives).
            setTitle(page.title);
          }}
          placeholder="Untitled"
        />
        <PearEditor
          key={String(page.id)}
          pageId={page.id}
          initialContent={content?.content ?? ""}
        />
      </div>
    </div>
  );
}
