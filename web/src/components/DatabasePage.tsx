"use client";

import { useState, useRef, useEffect } from "react";
import { useUpdatePageTitle } from "@/src/hooks/usePages";
import type { PageRow } from "@/src/hooks/usePages";
import { GridView } from "./GridView";

interface DatabasePageProps {
  page: PageRow;
}

export function DatabasePage({ page }: DatabasePageProps) {
  const updateTitle = useUpdatePageTitle();
  const [title, setTitle] = useState(page.title);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTitle(page.title);
  }, [page.title]);

  async function handleTitleChange(value: string) {
    setTitle(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      if (value.trim()) await updateTitle({ pageId: page.id, title: value });
    }, 400);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-8 pt-8 pb-4 flex-shrink-0">
        <input
          className="text-3xl font-bold text-neutral-900 dark:text-white bg-transparent outline-none w-full placeholder:text-neutral-300 dark:placeholder:text-neutral-700"
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder="Untitled Database"
        />
        <p className="text-xs text-neutral-400 dark:text-neutral-600 mt-1">Database</p>
      </div>
      <div className="flex-1 overflow-hidden px-4">
        <GridView page={page} />
      </div>
    </div>
  );
}
