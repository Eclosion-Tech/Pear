"use client";
import { useState } from "react";
import { createPropertyReference, type PropertyReference } from "@pear/trellis-ui";
import type { propertySourceChoices, PropertyResolution } from "@/src/lib/property-reference";
type Choice = ReturnType<typeof propertySourceChoices>[number];
export function PropertyReferenceView({ result, reference, canConfigure, choices, containingPageId, onSave, onOpen }: {
  result: PropertyResolution; reference: PropertyReference | null; canConfigure: boolean;
  choices: Choice[]; containingPageId: string; onSave(ref: PropertyReference): Promise<unknown>;
  onOpen(edit: boolean): void;
}) {
  const [configuring, setConfiguring] = useState(result.status === "unconfigured");
  const [mode, setMode] = useState<"self" | "page">(typeof reference?.binding.recordId === "string" ? "page" : "self");
  const [pageId, setPageId] = useState(typeof reference?.binding.recordId === "string" ? reference.binding.recordId : "");
  const [field, setField] = useState(reference?.binding.field ?? "");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = choices.find(p => p.pageId === (mode === "self" ? containingPageId : pageId));
  const supportedField = selected?.properties.some(p => p.id === field);
  const controls = "rounded px-2 py-1 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800";
  async function save() {
    if (!selected || !supportedField || !canConfigure) return;
    setBusy(true); setError("");
    try { await onSave(createPropertyReference(selected.schemaId, field, mode === "page" ? selected.pageId : undefined)); setConfiguring(false); }
    catch { setError("Could not save the reference. Try again."); }
    finally { setBusy(false); }
  }
  return <div tabIndex={0} aria-label="Property reference" className="group my-2 min-w-0 outline-none">
    {result.status === "ready" ? <div className="leading-7" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {result.value || <span className="text-neutral-400 italic">Empty property</span>}
    </div> : <p role="status" className="text-sm text-neutral-500">{
      result.status === "unconfigured" ? "Choose a property to display here." :
      result.status === "missing-context" ? "This reference needs a containing page." :
      result.status === "unsupported" ? "This property reference is missing or unsupported. Its settings have been retained." :
      "This property is unavailable."}</p>}
    <div className={`mt-1 flex flex-wrap items-center gap-1 text-neutral-500 ${configuring ? "" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"}`}>
      {result.status === "ready" && <>
        <span className="max-w-full truncate text-xs">{result.pageTitle} · {result.propertyName}</span>
        <button className={controls} onClick={() => onOpen(false)}>Open source</button>
        {result.canEdit && <button className={controls} onClick={() => onOpen(true)}>Edit property</button>}
      </>}
      {canConfigure && <button className={controls} aria-expanded={configuring} onClick={() => setConfiguring(!configuring)}>Reference settings</button>}
    </div>
    {configuring && canConfigure && <div className="mt-2 max-w-lg space-y-3 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-700">
      <fieldset disabled={busy} className="space-y-3">
        <legend className="mb-2 text-xs text-neutral-500">Property source</legend>
        <div className="flex flex-wrap gap-4">
          <label><input type="radio" checked={mode === "self"} onChange={() => { setMode("self"); setField(""); }} /> This page</label>
          <label><input type="radio" checked={mode === "page"} onChange={() => { setMode("page"); setField(""); }} /> Choose a page</label>
        </div>
        {mode === "page" && <>
          <input aria-label="Search pages" placeholder="Search pages…" value={search} onChange={e => setSearch(e.target.value)} className="w-full rounded border bg-transparent p-2" />
          <select aria-label="Source page" value={selected?.pageId ?? ""} onChange={e => { setPageId(e.target.value); setField(""); }} className="w-full rounded border bg-transparent p-2">
            <option value="">Choose a page</option>
            {choices.filter(p => p.pageId === pageId || p.title.toLowerCase().includes(search.toLowerCase())).map(p => <option key={p.pageId} value={p.pageId}>{p.title || "Untitled"} (#{p.pageId})</option>)}
          </select>
        </>}
        {selected ? <label className="block">Property
          <select aria-label="Property" className="mt-1 w-full rounded border bg-transparent p-2" value={supportedField ? field : ""} onChange={e => setField(e.target.value)}>
            <option value="">Choose a text property</option>
            {selected.properties.map(p => <option key={p.id} value={p.id}>{p.name} (#{p.id})</option>)}
          </select>
        </label> : <p className="text-xs text-neutral-500">{mode === "self" ? "This page has no accessible text properties." : "Choose an accessible page with text properties."}</p>}
        <div className="flex gap-3"><button disabled={!supportedField} className="rounded bg-neutral-900 px-3 py-1.5 text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900" onClick={() => void save()}>{busy ? "Saving…" : "Save reference"}</button>
          <button onClick={() => setConfiguring(false)}>Cancel</button></div>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}
