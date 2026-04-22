"use client";

import { useState } from "react";
import { useTable, useReducer, useSpacetimeDB } from "spacetimedb/react";
import type { Identity } from "spacetimedb";
import { tables, reducers } from "@/src/module_bindings";
import { useAiUserProfileByIdentity } from "@/src/hooks/useAiUsers";

/**
 * Context bar (Phase A) — visualises and edits what an AI user can see for
 * the current conversation turn.
 *
 * Chips are derived from `page_access_rule` (and one day `block_access_rule`)
 * scoped to the AI user's identity. Each chip shows the page title and the
 * permission level. Clicking removes the rule (revoke); the "+" surface lets
 * a participant grant a fresh page.
 *
 * Pending access requests (the "ai user asked for X" pattern) will render as
 * Accept/Deny chips here in a follow-up — the data path isn't wired yet.
 */
export function ContextBar({
  pageId,
  aiUserIdentity,
}: {
  pageId: bigint;
  aiUserIdentity: Identity;
}) {
  const [pageRules] = useTable(tables.page_access_rule);
  const [pages] = useTable(tables.page);
  const setRule = useReducer(reducers.setPageAccessRule);
  const clearRule = useReducer(reducers.clearPageAccessRule);
  const { identity: meIdentity } = useSpacetimeDB();
  const aiProfile = useAiUserProfileByIdentity(aiUserIdentity);
  const [adding, setAdding] = useState(false);

  const aiHex = aiUserIdentity.toHexString();
  const grants = pageRules.filter(
    (r) =>
      r.principal.tag === "WorkspaceMember" &&
      r.principal.value.toHexString() === aiHex,
  );

  // Always include the host page implicitly so the chip set isn't empty
  // on first load — the AI user can always see the page they're talking on.
  const hostPage = pages.find((p) => p.id === pageId);
  const hostChip = hostPage
    ? {
        id: -1n,
        pageId,
        permission: { tag: "Read" as const },
        implicit: true,
        title: hostPage.title || "Untitled",
      }
    : null;

  const grantChips = grants.map((r) => {
    const p = pages.find((pp) => pp.id === r.pageId);
    return {
      id: r.id,
      pageId: r.pageId,
      permission: r.permission,
      implicit: false,
      title: p?.title || `#${r.pageId}`,
    };
  });

  const allChips = hostChip
    ? [hostChip, ...grantChips.filter((c) => c.pageId !== pageId)]
    : grantChips;

  return (
    <div className="flex items-center gap-1.5 flex-wrap px-3 py-2 border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500 mr-1">
        Context for {aiProfile?.displayName ?? "AI"}
      </span>
      {allChips.map((chip) => (
        <button
          key={chip.id.toString()}
          onClick={() => {
            if (chip.implicit) return;
            void clearRule({ pageId: chip.pageId, principal: aiUserIdentity });
          }}
          className={`group inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium transition-colors ${
            chip.implicit
              ? "bg-neutral-200 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300"
              : chip.permission.tag === "Write"
                ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60"
                : "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-900/60"
          }`}
          title={
            chip.implicit
              ? "Host page (always visible to participants)"
              : `Click to revoke ${chip.permission.tag} access`
          }
        >
          <span className="truncate max-w-[140px]">{chip.title}</span>
          <span className="opacity-60">{chip.permission.tag.toLowerCase()}</span>
          {!chip.implicit && (
            <span className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5">
              ×
            </span>
          )}
        </button>
      ))}
      {!adding && (
        <button
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-0.5 text-[11px] px-2 py-0.5 rounded-full bg-neutral-100 dark:bg-neutral-800 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
          disabled={!meIdentity}
          title="Grant another page"
        >
          + add
        </button>
      )}
      {adding && (
        <PageGrantPicker
          excludePageIds={new Set(allChips.map((c) => c.pageId))}
          onPick={async (pid, perm) => {
            await setRule({
              pageId: pid,
              principal: aiUserIdentity,
              permission: { tag: perm } as never,
            });
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}

function PageGrantPicker({
  excludePageIds,
  onPick,
  onCancel,
}: {
  excludePageIds: Set<bigint>;
  onPick: (pageId: bigint, perm: "Read" | "Write") => void;
  onCancel: () => void;
}) {
  const [pages] = useTable(tables.page);
  const [search, setSearch] = useState("");
  const candidates = pages
    .filter(
      (p) =>
        !p.deletedAt &&
        !excludePageIds.has(p.id) &&
        (p.title.toLowerCase().includes(search.toLowerCase()) || !search),
    )
    .slice(0, 8);
  return (
    <div className="inline-flex items-center gap-1 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded px-1 py-0.5">
      <input
        autoFocus
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="search pages…"
        className="text-[11px] bg-transparent outline-none w-32 text-neutral-800 dark:text-neutral-200"
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && candidates[0]) {
            onPick(candidates[0].id, "Read");
          }
        }}
      />
      {candidates.length > 0 && (
        <div className="flex items-center gap-1">
          {candidates.slice(0, 3).map((p) => (
            <button
              key={p.id.toString()}
              className="text-[11px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-600"
              onClick={() => onPick(p.id, "Read")}
              title="Grant Read"
            >
              {p.title || "Untitled"}
            </button>
          ))}
        </div>
      )}
      <button
        onClick={onCancel}
        className="text-[11px] px-1 py-0.5 text-neutral-400 hover:text-neutral-700"
      >
        ×
      </button>
    </div>
  );
}
