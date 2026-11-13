"use client";
import { useState } from "react";

/** Page-panel presentation only; database cells keep their compact editor. */
export function LongTextProperty({ value, name, canEdit, onSave, forceEdit = false }: {
  value: string; name: string; canEdit: boolean; onSave(value: string): Promise<unknown>; forceEdit?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(forceEdit);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true); setError("");
    try { await onSave(draft); setEditing(false); }
    catch { setError("Could not save this property. Your edit is still here."); }
    finally { setBusy(false); }
  }
  if (editing && canEdit) return <div className="space-y-2 p-1">
    <textarea autoFocus aria-label={name} value={draft} disabled={busy} rows={8}
      className="w-full min-w-0 resize-y rounded border border-neutral-300 bg-transparent p-2 text-sm leading-6 dark:border-neutral-600"
      onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        if (event.key === "Escape" && !busy) { event.stopPropagation(); setEditing(false); }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
      }} />
    <div className="flex gap-3 text-xs"><button disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      <button disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
  </div>;
  const long = value.length > 320 || value.split("\n").length > 4;
  return <div className="px-2 py-1">
    <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", ...(!expanded && long ? {
      display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical" as const, overflow: "hidden",
    } : {}) }} className="text-sm leading-6">
      {value || <span className="text-neutral-400 italic">Empty</span>}
    </div>
    <div className="mt-1 flex gap-3 text-xs text-neutral-500">
      {long && <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show more"}</button>}
      {canEdit && <button onClick={() => { setDraft(value); setError(""); setEditing(true); }}>Edit property</button>}
    </div>
  </div>;
}
