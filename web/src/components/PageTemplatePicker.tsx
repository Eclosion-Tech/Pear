"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSpacetimeDB } from "spacetimedb/react";
import { usePageAccess } from "@/src/hooks/usePageAccess";
import { blockReferenceHref } from "@/src/lib/blockReferenceLink";
import { effectivePagePermission, pageAccessScope } from "@/src/lib/pageAccess";
import type { DbConnection } from "@/src/module_bindings";

/** Existing pages are reusable templates; no snapshot of referenced values is made. */
export function PageTemplatePicker({ pageId, duplicate = false }: { pageId: bigint; duplicate?: boolean }) {
  const access = usePageAccess(pageId);
  const data = access;
  const page = access.pages.find(p => p.id === pageId);
  const parentAccess = usePageAccess(duplicate ? page?.parentId ?? pageId : pageId);
  const { getConnection } = useSpacetimeDB();
  const route = useParams(), router = useRouter();
  const slug = Array.isArray(route?.slug) ? route.slug[0] : route?.slug;
  const [open, setOpen] = useState(false), [source, setSource] = useState(duplicate ? String(pageId) : "");
  const [title, setTitle] = useState(duplicate ? `${page?.title || "Untitled"} copy` : "Untitled");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!parentAccess.canEdit || !access.permission) return null;
  const choices = data.ready ? data.pages.filter(p => p.deletedAt == null && p.pageType.tag === "Doc" && p.contentFormat.tag === "ComponentTree" &&
    effectivePagePermission(pageAccessScope(p.id, data.pages, data.rules), data.principal, data.privileged)) : [];
  async function create() {
    const conn = getConnection() as DbConnection | null;
    if (!conn || !source || busy) return;
    setBusy(true); setError("");
    const previous = new Set(Array.from(conn.db.page.iter(), p => p.id));
    const parentId = duplicate ? page?.parentId : pageId;
    try {
      await conn.reducers.createPageFromTemplate({ sourcePageId: BigInt(source), parentId, title });
      // Do not guess when concurrent creates make the new identity ambiguous.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const candidates = Array.from(conn.db.page.iter()).filter(p => !previous.has(p.id) && p.parentId === parentId && p.title === title);
        if (candidates.length === 1) { router.push(blockReferenceHref({ surfaceId: candidates[0].id }, slug)); setOpen(false); return; }
        if (candidates.length > 1) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      setError("Created. Open the new page from the database or sidebar.");
    } catch { setError("Could not create this page. Check access to the template and destination."); }
    finally { setBusy(false); }
  }
  return <div className="my-2 text-sm">
    <button onClick={() => setOpen(!open)} className="rounded border border-neutral-200 px-3 py-1.5 dark:border-neutral-700">{duplicate ? "Duplicate page" : "New from page template"}</button>
    {open && <div className="mt-2 max-w-md space-y-2 rounded border border-neutral-200 p-3 dark:border-neutral-700">
      {!duplicate && <label className="block">Template page<select aria-label="Template page" value={choices.some(p => String(p.id) === source) ? source : ""} onChange={e => setSource(e.target.value)} className="mt-1 w-full rounded border bg-transparent p-2">
        <option value="">Choose a page</option>{choices.map(p => <option key={String(p.id)} value={String(p.id)}>{p.title || "Untitled"} (#{String(p.id)})</option>)}
      </select></label>}
      <label className="block">New page title<input aria-label="New page title" value={title} onChange={e => setTitle(e.target.value)} className="mt-1 w-full rounded border bg-transparent p-2" /></label>
      <p className="text-xs text-neutral-500">This page references follow the new record. References to chosen pages keep their source.</p>
      <button disabled={busy || !choices.some(p => String(p.id) === source)} onClick={() => void create()}>{busy ? "Creating…" : "Create page"}</button>
      {error && <p role="status">{error}</p>}
    </div>}
  </div>;
}
