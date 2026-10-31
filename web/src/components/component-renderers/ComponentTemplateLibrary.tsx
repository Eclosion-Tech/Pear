"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import { RetainedInterfaceView } from "@eclosion-tech/trellis-react";
import { canonicalJson, compareComponentTemplateVersions, componentTemplateReference, createRetainedInterface, interfaceCreationFingerprint, prepareComponentTemplate, validateComponentTemplatePackage, type ComponentTemplateOptions, type ComponentTemplatePackage, type InterfaceRegistry, type RetainedInterface } from "@eclosion-tech/trellis";
import { INTERFACE_REGISTRY, readPageInterface } from "@pear/trellis-ui";
import type { DbConnection } from "@/src/module_bindings";
import { useComponentRepositoryWriter, useWorkspaceComponentTemplates, useWorkspaceComponentVersions } from "@/src/hooks/useComponentRepository";
import { usePageAccess } from "@/src/hooks/usePageAccess";
function LibraryDialog({ title, onClose, children }: {
    title: string;
    onClose: () => void;
    children: ReactNode;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
    return <dialog ref={dialog} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }} className="max-h-[85vh] w-[min(56rem,94vw)] overflow-y-auto rounded-xl border border-neutral-300 bg-white p-6 text-neutral-900 shadow-xl backdrop:bg-black/60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
    <div className="mb-4 flex items-center justify-between gap-4"><h2 className="text-xl font-semibold">{title}</h2><button type="button" onClick={onClose} aria-label="Close component library">Close</button></div>{children}
  </dialog>;
}
type Preview = {
    package: ComponentTemplatePackage;
    hash: string;
    saved: RetainedInterface;
    registry: InterfaceRegistry;
};
async function previewPackage(value: ComponentTemplatePackage): Promise<Preview> {
    const registry = { catalog: INTERFACE_REGISTRY.catalog, definitions: [...INTERFACE_REGISTRY.definitions, value.definition] };
    const saved = await createRetainedInterface({ templateId: value.definition.template.id, templateVersion: value.definition.template.version, parameters: {} }, { registry, principal: "preview", parentId: "preview", requestId: "preview", documentId: "repository:preview", instanceId: "repository:preview" });
    return { package: value, hash: (await componentTemplateReference(value)).hash, saved, registry };
}
function TemplatePreview({ preview }: {
    preview: Preview;
}) {
    return <fieldset disabled className="my-4 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700"><legend>Fresh instance preview</legend><RetainedInterfaceView key={preview.hash} saved={preview.saved} registry={preview.registry} principalKey="preview" canEdit={false} onCommit={async () => { throw new Error("This is a preview."); }}/></fieldset>;
}
export function SaveComponentTemplate({ saved, registry, componentId, principal, canEdit }: {
    saved: RetainedInterface;
    registry: InterfaceRegistry;
    componentId: string;
    principal: string;
    canEdit: boolean;
}) {
    const [open, setOpen] = useState(false), [message, setMessage] = useState("");
    useEffect(() => { setOpen(false); setMessage(""); }, [principal]);
    return <><button type="button" disabled={!canEdit} onClick={() => { setOpen(true); setMessage(""); }}>Save as template</button>{message && <span role="status">{message}</span>}{open && <SaveTemplateForm key={principal} saved={saved} registry={registry} componentId={componentId} canEdit={canEdit} onClose={() => setOpen(false)} onSaved={() => { setMessage("Template saved to the workspace library."); setOpen(false); }}/>}</>;
}
function SaveTemplateForm({ saved, registry, componentId, canEdit, onClose, onSaved }: {
    saved: RetainedInterface;
    registry: InterfaceRegistry;
    componentId: string;
    canEdit: boolean;
    onClose: () => void;
    onSaved: () => void;
}) {
    const heading = saved.document.nodes.find(n => n.type === "Heading")?.text?.map(run => run.text).join("") || "My component";
    const [name, setName] = useState(heading), [slug, setSlug] = useState(heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "my-component"), [version, setVersion] = useState("1.0.0"), [description, setDescription] = useState(""), [tags, setTags] = useState("");
    const [preview, setPreview] = useState<(Preview & {
        revision: number;
        options: ComponentTemplateOptions;
    }) | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const attempt = useRef<{
        hash: string;
        requestId: string;
    } | null>(null), write = useComponentRepositoryWriter();
    const options: ComponentTemplateOptions = useMemo(() => ({ name, slug, version, description, tags: tags.split(",").map(tag => tag.trim()).filter(Boolean) }), [name, slug, version, description, tags]);
    const optionsKey = canonicalJson(options);
    useEffect(() => { setPreview(null); attempt.current = null; }, [optionsKey]);
    async function prepare() { setBusy(true); setError(""); try {
        const value = await prepareComponentTemplate(saved, registry, options);
        setPreview({ ...await previewPackage(value), revision: saved.document.revision, options });
    }
    catch (error) {
        setError(error instanceof Error ? error.message : String(error));
    }
    finally {
        setBusy(false);
    } }
    async function publish() { if (!preview || !canEdit || canonicalJson(preview.options) !== optionsKey)
        return; setBusy(true); setError(""); if (attempt.current?.hash !== preview.hash)
        attempt.current = { hash: preview.hash, requestId: `publish:${crypto.randomUUID()}` }; try {
        await write(attempt.current.requestId, { kind: "publish", componentId, sourceRevision: preview.revision, options: preview.options, previewHash: preview.hash, audience: "workspace" });
        onSaved();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("COMMIT_UNCERTAIN"))
            attempt.current = null;
        setError(message);
    }
    finally {
        setBusy(false);
    } }
    return <LibraryDialog title="Save component template" onClose={onClose}>
    <p className="mb-4">This template will be visible to everyone in this workspace. Preview the content and defaults before publishing.</p>
    <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
      <label>Name<input className="block w-full rounded border bg-transparent p-2" value={name} maxLength={160} onChange={e => setName(e.target.value)}/></label>
      <label>Template slug<input className="block w-full rounded border bg-transparent p-2" value={slug} maxLength={64} onChange={e => setSlug(e.target.value)}/></label>
      <label>Version<input className="block w-full rounded border bg-transparent p-2" value={version} onChange={e => setVersion(e.target.value)}/></label>
      <label>Tags (comma separated)<input className="block w-full rounded border bg-transparent p-2" value={tags} onChange={e => setTags(e.target.value)}/></label>
      <label className="sm:col-span-2">Description<textarea className="block w-full rounded border bg-transparent p-2" value={description} maxLength={4000} onChange={e => setDescription(e.target.value)}/></label>
    </fieldset>
    <p className="my-3 text-sm">Checkboxes start unchecked. Field values and saved action output start empty. Private drafts stay out of the library. Published versions cannot be overwritten.</p>
    <button type="button" disabled={busy || !canEdit} onClick={() => void prepare()}>Preview template</button>
    {preview && <><TemplatePreview preview={preview}/><details><summary>Shared content, defaults and actions</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(preview.package, null, 2)}</pre></details>{preview.revision !== saved.document.revision && <p role="alert">The source changed after this preview. Preview it again before publishing.</p>}<button type="button" className="mt-4" disabled={busy || !canEdit || preview.revision !== saved.document.revision} onClick={() => void publish()}>{attempt.current ? "Retry publication" : "Publish to workspace"}</button></>}
    {error && <p role="alert" className="mt-3">{error}</p>}
  </LibraryDialog>;
}
export function ComponentLibraryButton({ surfaceId, parentId }: {
    surfaceId: bigint;
    parentId: bigint | null;
}) {
    const access = usePageAccess(surfaceId), [open, setOpen] = useState(false);
    useEffect(() => setOpen(false), [access.principal, surfaceId]);
    return <><button type="button" className="mb-3 rounded border px-3 py-1 text-sm" onClick={() => setOpen(true)}>Component library</button>{open && <WorkspaceLibrary key={`${surfaceId}:${access.principal}`} surfaceId={surfaceId} parentId={parentId} onClose={() => setOpen(false)}/>}</>;
}
function WorkspaceLibrary({ surfaceId, parentId, onClose }: {
    surfaceId: bigint;
    parentId: bigint | null;
    onClose: () => void;
}) {
    const access = usePageAccess(surfaceId), { rows: families, ready } = useWorkspaceComponentTemplates(), write = useComponentRepositoryWriter(), { getConnection } = useSpacetimeDB();
    const [search, setSearch] = useState(""), [includeArchived, setIncludeArchived] = useState(false), [selected, setSelected] = useState(""), [version, setVersion] = useState(""), [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
    const { rows: versions, ready: versionsReady } = useWorkspaceComponentVersions(selected);
    const family = families.find(row => row.templateId === selected), row = versions.find(row => row.version === version);
    const request = useRef<{
        key: string;
        id: string;
    } | null>(null), live = useRef(access);
    live.current = access;
    useEffect(() => { let cancelled = false; setPreview(null); setError(""); request.current = null; if (!row)
        return; void (async () => { try {
        const value = await validateComponentTemplatePackage(JSON.parse(row.packageJson), INTERFACE_REGISTRY), next = await previewPackage(value);
        if (next.hash !== row.contentHash)
            throw new Error("The saved package hash does not match this version.");
        if (!cancelled)
            setPreview(next);
    }
    catch (error) {
        if (!cancelled)
            setError(error instanceof Error ? error.message : String(error));
    } })(); return () => { cancelled = true; }; }, [row?.packageJson, row?.contentHash]);
    const visible = families.filter(row => (includeArchived || !row.archived) && `${row.name} ${row.description} ${row.tagsJson}`.toLowerCase().includes(search.toLowerCase()));
    const canManage = !!family && (family.owner.toHexString() === access.principal || access.privileged);
    async function archive() { if (!family)
        return; setBusy(true); setError(""); const key = `archive:${family.templateId}:${family.revision}:${!family.archived}`; if (request.current?.key !== key)
        request.current = { key, id: `library:${crypto.randomUUID()}` }; try {
        await write(request.current.id, { kind: "archive", templateId: family.templateId, baseRevision: Number(family.revision), archived: !family.archived });
        request.current = null;
        setMessage("Library entry updated. Existing instances keep their saved version.");
    }
    catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (!text.includes("COMMIT_UNCERTAIN"))
            request.current = null;
        setError(text);
    }
    finally {
        setBusy(false);
    } }
    async function insert() {
        if (!preview || !parentId || !live.current.canEdit || family?.archived)
            return;
        setBusy(true);
        setError("");
        const connection = getConnection() as DbConnection | null, principal = access.principal;
        const check = () => { if (!connection || live.current.principal !== principal || connection.identity?.toHexString() !== principal || !live.current.canEdit)
            throw new Error("This editing session ended or page access changed."); };
        const descriptor = { templateId: preview.package.definition.template.id, templateVersion: preview.package.definition.template.version, parameters: {} };
        const key = canonicalJson([parentId.toString(), descriptor]);
        if (request.current?.key !== key)
            request.current = { key, id: `library:${crypto.randomUUID()}` };
        const requestId = request.current.id;
        try {
            check();
            const fingerprint = await interfaceCreationFingerprint(descriptor);
            check();
            try {
                await connection!.reducers.createTrellisPanel({ parentId: parentId.toString(), requestId, parametersJson: canonicalJson(descriptor) });
            }
            catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                if (/lacks .*access|Authentication required|TEMPLATE_ARCHIVED|REQUEST_REUSED|TEMPLATE_NOT_FOUND/.test(text))
                    throw error;
            }
            for (let attempt = 0; attempt < 25; attempt++) {
                check();
                for (const node of connection!.db.component_node.iter()) {
                    if (node.surfaceId !== surfaceId || node.componentType !== "TrellisPanel" || node.deletedAt != null)
                        continue;
                    let saved: RetainedInterface;
                    try {
                        saved = readPageInterface(node.props, String(surfaceId), String(node.id), preview.registry);
                    }
                    catch {
                        continue;
                    }
                    if (saved.creation.principal === principal && saved.creation.parentId === parentId.toString() && saved.creation.requestId === requestId) {
                        if (saved.creation.fingerprint !== fingerprint)
                            throw new Error("REQUEST_REUSED: Another component uses this request.");
                        request.current = null;
                        setMessage("Component inserted with independent saved state.");
                        return;
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 40));
            }
            throw new Error("COMMIT_UNCERTAIN: The new instance has not arrived. Retry the same insertion.");
        }
        catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (!text.includes("COMMIT_UNCERTAIN"))
                request.current = null;
            setError(text);
        }
        finally {
            setBusy(false);
        }
    }
    return <LibraryDialog title="Workspace component library" onClose={onClose}>
    <p className="mb-3">Reusable templates shared in this workspace. Each insertion creates independent state. To share an existing live instance, use its page or chat reference.</p>
    <label>Search components<input className="ml-2 rounded border bg-transparent p-2" value={search} maxLength={160} onChange={e => setSearch(e.target.value)}/></label>
    <label className="ml-3"><input type="checkbox" checked={includeArchived} onChange={e => setIncludeArchived(e.target.checked)}/> Show archived</label>
    {!ready ? <p role="status">Loading component library…</p> : !visible.length ? <p>No matching templates. Build an interface, then choose “Save as template.”</p> : <ul className="my-4 flex flex-wrap gap-2">{visible.map(row => <li key={row.templateId}><button type="button" aria-pressed={selected === row.templateId} className="rounded border p-2" disabled={busy} onClick={() => { setSelected(row.templateId); setVersion(row.latestVersion); setMessage(""); }}>{row.name}{row.archived ? " (archived)" : ""}</button></li>)}</ul>}
    {family && <section aria-label="Selected component template"><h3 className="text-lg font-semibold">{family.name}</h3><p>{family.description}</p><label>Template version<select className="m-2 rounded border bg-transparent p-2" disabled={busy} value={version} onChange={e => setVersion(e.target.value)}>{[...versions].sort((a, b) => compareComponentTemplateVersions(b.version, a.version)).map(row => <option key={row.version} value={row.version}>{row.version}</option>)}</select></label>{!versionsReady && <p role="status">Loading this template…</p>}{preview && <><TemplatePreview preview={preview}/><button type="button" disabled={busy || !access.canEdit || !parentId || family.archived} onClick={() => void insert()}>{request.current?.key.startsWith("[") ? "Retry insertion" : "Insert into this page"}</button></>}{canManage && <button type="button" className="ml-3" disabled={busy} onClick={() => void archive()}>{family.archived ? "Restore template" : "Archive template"}</button>}{family.archived && <p>This template is archived. Existing instances keep working.</p>}</section>}
    {message && <p role="status" className="mt-3">{message}</p>}{error && <p role="alert" className="mt-3">{error}</p>}
  </LibraryDialog>;
}
