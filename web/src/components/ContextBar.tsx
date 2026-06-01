"use client";

import { useEffect, useState } from "react";
import { useTable, useReducer, useSpacetimeDB } from "spacetimedb/react";
import type { Identity } from "spacetimedb";
import { tables, reducers } from "@/src/module_bindings";
import { useAiUserProfileByIdentity } from "@/src/hooks/useAiUsers";

type PermissionTag = "Read" | "Write";
type ContextChip = {
  id: bigint;
  pageId: bigint;
  permission: { tag: PermissionTag };
  implicit: boolean;
  title: string;
};

function permissionRank(permission: PermissionTag) {
  return permission === "Write" ? 2 : 1;
}

function permissionCovers(have: PermissionTag, needed: PermissionTag) {
  return permissionRank(have) >= permissionRank(needed);
}

/**
 * Context bar (Phase A) — visualises and edits what an AI user can see for
 * the current conversation turn.
 *
 * Chips show the page context for this conversation. The underlying access
 * rules are global grants, so the UI deliberately filters them down to memory,
 * the host page, and grants that originated in this conversation.
 *
 * Pending access requests (the "ai user asked for X" pattern) will render as
 * Accept/Deny chips here in a follow-up — the data path isn't wired yet.
 */
export function ContextBar({
  pageId,
  aiUserIdentity,
  conversationId,
  activePageId,
  onFork,
}: {
  /** Host page the conversation is attached to, if any. `undefined` for AI DMs. */
  pageId?: bigint;
  aiUserIdentity: Identity;
  conversationId: bigint;
  activePageId?: bigint;
  onFork?: () => void;
}) {
  const [pageRules] = useTable(tables.page_access_rule);
  const [accessRequests] = useTable(tables.page_access_request);
  const [pages] = useTable(tables.page);
  const [aiUserMemories] = useTable(tables.ai_user_memory);
  const setRule = useReducer(reducers.setPageAccessRule);
  const clearRule = useReducer(reducers.clearPageAccessRule);
  const resolveAccessRequest = useReducer(reducers.resolvePageAccessRequest);
  const { identity: meIdentity } = useSpacetimeDB();
  const aiProfile = useAiUserProfileByIdentity(aiUserIdentity);
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [manualContextPageIds, setManualContextPageIds] = useState<Set<bigint>>(
    () => new Set(),
  );

  useEffect(() => {
    setAdding(false);
    setReplacing(false);
    setManualContextPageIds(new Set());
  }, [conversationId]);

  const aiHex = aiUserIdentity.toHexString();
  const memory = aiProfile
    ? aiUserMemories.find((m) => m.aiUserId === aiProfile.aiUserId)
    : undefined;
  const memoryPageIds = new Set<bigint>();
  if (memory) {
    memoryPageIds.add(memory.rootPageId);
    if (memory.workingPageId != null) memoryPageIds.add(memory.workingPageId);
    if (memory.longTermPageId != null) memoryPageIds.add(memory.longTermPageId);
  }

  const conversationGrantedPageIds = new Set(
    accessRequests
      .filter(
        (r) =>
          r.conversationId === conversationId &&
          r.status.tag === "Approved" &&
          r.principal.tag === "WorkspaceMember" &&
          r.principal.value.toHexString() === aiHex,
      )
      .map((r) => r.pageId),
  );

  const visibleGrantPageIds = new Set<bigint>([
    ...(pageId != null ? [pageId] : []),
    ...memoryPageIds,
    ...conversationGrantedPageIds,
    ...manualContextPageIds,
  ]);

  const grants = pageRules.filter(
    (r) =>
      r.principal.tag === "WorkspaceMember" &&
      r.principal.value.toHexString() === aiHex &&
      visibleGrantPageIds.has(r.pageId),
  );

  function pageAndAncestorIds(pid: bigint): bigint[] {
    const ids: bigint[] = [];
    const seen = new Set<string>();
    let current: bigint | undefined = pid;
    while (current != null) {
      const key = current.toString();
      if (seen.has(key)) break;
      seen.add(key);
      ids.push(current);
      current = pages.find((p) => p.id === current)?.parentId;
    }
    return ids;
  }

  function ancestorGrantCovers(chip: ContextChip, candidates: ContextChip[]) {
    const ancestors = new Set(pageAndAncestorIds(chip.pageId).slice(1).map(String));
    return candidates.some(
      (candidate) =>
        candidate.pageId !== chip.pageId &&
        ancestors.has(candidate.pageId.toString()) &&
        permissionCovers(candidate.permission.tag, chip.permission.tag),
    );
  }

  // Always include the host page implicitly so the chip set isn't empty
  // on first load — the AI user can always see the page they're talking on.
  const hostPage = pageId != null ? pages.find((p) => p.id === pageId) : undefined;
  const hostChip: ContextChip | null = hostPage
    ? {
        id: -1n,
        pageId: hostPage.id,
        permission: { tag: "Read" as const },
        implicit: true,
        title: hostPage.title || "Untitled",
      }
    : null;

  const rawGrantChips = grants.map((r) => {
    const p = pages.find((pp) => pp.id === r.pageId);
    return {
      id: r.id,
      pageId: r.pageId,
      permission: r.permission,
      implicit: false,
      title: p?.title || `#${r.pageId}`,
    };
  });
  const grantChipsByPage = new Map<string, ContextChip>();
  for (const chip of rawGrantChips) {
    const key = chip.pageId.toString();
    const existing = grantChipsByPage.get(key);
    if (!existing || permissionRank(chip.permission.tag) > permissionRank(existing.permission.tag)) {
      grantChipsByPage.set(key, chip);
    }
  }
  const dedupedGrantChips = [...grantChipsByPage.values()];
  const grantChips = dedupedGrantChips.filter(
    (chip) => chip.pageId === pageId || !ancestorGrantCovers(chip, dedupedGrantChips),
  );

  const explicitHostGrant = grantChips.find((c) => c.pageId === pageId);
  const allChips = explicitHostGrant
    ? [explicitHostGrant, ...grantChips.filter((c) => c.pageId !== pageId)]
    : hostChip
      ? [hostChip, ...grantChips]
      : grantChips;

  const pendingRequests = accessRequests.filter(
    (r) =>
      r.conversationId === conversationId &&
      r.status.tag === "Pending" &&
      r.principal.tag === "WorkspaceMember" &&
      r.principal.value.toHexString() === aiHex,
  );

  const activePage =
    activePageId != null && activePageId !== pageId
      ? pages.find((p) => p.id === activePageId)
      : null;
  const activeAlreadyGranted =
    activePage != null && allChips.some((c) => c.pageId === activePageId);
  const showActivePage = activePage != null && !activeAlreadyGranted;

  async function handleAddActivePage(permission: "Read" | "Write") {
    if (!activePageId) return;
    await setRule({
      pageId: activePageId,
      principal: aiUserIdentity,
      permission: { tag: permission } as never,
    });
    setManualContextPageIds((prev) => new Set(prev).add(activePageId));
  }

  async function handleReplaceContext() {
    if (!activePageId || replacing) return;
    setReplacing(true);
    try {
      for (const chip of grantChips) {
        if (memoryPageIds.has(chip.pageId)) continue;
        await clearRule({ pageId: chip.pageId, principal: aiUserIdentity });
      }
      await setRule({
        pageId: activePageId,
        principal: aiUserIdentity,
        permission: { tag: "Read" } as never,
      });
      setManualContextPageIds(new Set([activePageId]));
    } finally {
      setReplacing(false);
    }
  }

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
      {pendingRequests.map((request) => {
        const p = pages.find((pp) => pp.id === request.pageId);
        const title = p?.title || `#${request.pageId}`;
        const perm = request.permission.tag;
        return (
          <div
            key={request.id.toString()}
            className="inline-flex items-center gap-1 rounded border border-amber-200 dark:border-amber-800/70 bg-amber-50 dark:bg-amber-950/30 px-2 py-1 text-[11px]"
          >
            <span className="text-amber-700 dark:text-amber-300 truncate max-w-[180px]">
              Grant {perm.toLowerCase()} to {title}?
            </span>
            <button
              onClick={() =>
                void resolveAccessRequest({ requestId: request.id, approve: true })
              }
              className="rounded bg-amber-600 px-1.5 py-0.5 font-medium text-white hover:bg-amber-700"
              title={request.reason || `Grant ${perm} access`}
            >
              Approve
            </button>
            <button
              onClick={() =>
                void resolveAccessRequest({ requestId: request.id, approve: false })
              }
              className="rounded px-1.5 py-0.5 text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/50"
              title="Deny this request"
            >
              Deny
            </button>
          </div>
        );
      })}
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
            setManualContextPageIds((prev) => new Set(prev).add(pid));
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {showActivePage && (
        <div className="flex items-center gap-1 w-full pt-1.5 mt-0.5 border-t border-neutral-200 dark:border-neutral-700">
          <span className="text-[10px] text-neutral-400 shrink-0">Viewing:</span>
          <span className="text-[11px] text-neutral-600 dark:text-neutral-300 font-medium truncate max-w-[100px]">
            {activePage.title || "Untitled"}
          </span>
          <button
            onClick={() => void handleAddActivePage("Read")}
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-900/60 transition-colors"
            title="Grant read access on this page"
          >
            Read
          </button>
          <button
            onClick={() => void handleAddActivePage("Write")}
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/60 transition-colors"
            title="Grant write access on this page"
          >
            Write
          </button>
          <button
            onClick={() => void handleReplaceContext()}
            disabled={replacing}
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/60 disabled:opacity-40 transition-colors"
            title="Replace all context with this page"
          >
            Replace
          </button>
          {onFork && (
            <button
              onClick={onFork}
              className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 hover:bg-violet-200 dark:hover:bg-violet-900/60 transition-colors"
              title="Start a new conversation on this page"
            >
              Fork
            </button>
          )}
        </div>
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
            <div
              key={p.id.toString()}
              className="inline-flex overflow-hidden rounded bg-neutral-100 dark:bg-neutral-700"
            >
              <button
                className="max-w-[90px] truncate px-1.5 py-0.5 text-[11px] text-neutral-700 hover:bg-emerald-100 dark:text-neutral-300 dark:hover:bg-emerald-900/40"
                onClick={() => onPick(p.id, "Read")}
                title="Grant Read"
              >
                {p.title || "Untitled"}
              </button>
              <button
                className="border-l border-neutral-200 px-1 py-0.5 text-[10px] font-semibold text-blue-700 hover:bg-blue-100 dark:border-neutral-600 dark:text-blue-300 dark:hover:bg-blue-900/40"
                onClick={() => onPick(p.id, "Write")}
                title="Grant Write"
              >
                W
              </button>
            </div>
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
