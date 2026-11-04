"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import {
  AuthoredComponentView,
  RetainedInterfaceView,
} from "@eclosion-tech/trellis-react";
import {
  canonicalJson,
  sha256,
  instantiateAuthoredTemplate,
  authoredTemplateHash,
  prepareAuthoredTemplate,
  reusableComponentReference,
  validateReusableComponentPackage,
  compareComponentTemplateVersions,
  componentTemplateReference,
  createRetainedInterface,
  interfaceCreationFingerprint,
  prepareComponentTemplate,
  validateComponentTemplatePackage,
  type ComponentTemplateOptions,
  type ReusableComponentPackage,
  type AuthoredComponent,
  type InterfaceRegistry,
  type RetainedInterface,
} from "@eclosion-tech/trellis";
import {
  INTERFACE_REGISTRY,
  readPageComponent,
  readPageInterface,
} from "@pear/trellis-ui";
import { NewComponentButton } from "./NewComponentButton";
import type { DbConnection } from "@/src/module_bindings";
import {
  useComponentRepositoryWriter,
  useWorkspaceComponentTemplates,
  useWorkspaceComponentVersions,
} from "@/src/hooks/useComponentRepository";
import { usePageAccess } from "@/src/hooks/usePageAccess";
import { useScopedTable } from "@/src/hooks/useScopedTable";
import { tables } from "@/src/module_bindings";
import type { ComponentNode } from "@/src/module_bindings/types";
function LibraryDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="max-h-[85vh] w-[min(56rem,94vw)] overflow-y-auto rounded-xl border border-neutral-300 bg-white p-6 text-neutral-900 shadow-xl backdrop:bg-black/60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close component library"
        >
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}
type Preview = {
  package: ReusableComponentPackage;
  hash: string;
  saved: RetainedInterface | AuthoredComponent;
  registry: InterfaceRegistry;
};
async function previewPackage(
  value: ReusableComponentPackage,
): Promise<Preview> {
  if (value.format === "trellis_authored_template_v1")
    return {
      package: value,
      hash: await authoredTemplateHash(value),
      registry: INTERFACE_REGISTRY,
      saved: await instantiateAuthoredTemplate(
        value,
        INTERFACE_REGISTRY.catalog,
        {
          principal: "preview",
          parentId: "preview",
          requestId: "preview",
          documentId: "repository:preview",
          instanceId: "repository:preview",
        },
      ),
    };
  const registry = {
    catalog: INTERFACE_REGISTRY.catalog,
    definitions: [...INTERFACE_REGISTRY.definitions, value.definition],
  };
  const saved = await createRetainedInterface(
    {
      templateId: value.definition.template.id,
      templateVersion: value.definition.template.version,
      parameters: {},
    },
    {
      registry,
      principal: "preview",
      parentId: "preview",
      requestId: "preview",
      documentId: "repository:preview",
      instanceId: "repository:preview",
    },
  );
  return {
    package: value,
    hash: (await componentTemplateReference(value)).hash,
    saved,
    registry,
  };
}
function TemplatePreview({ preview }: { preview: Preview }) {
  return (
    <fieldset
      disabled
      className="my-4 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700"
    >
      <legend>Fresh instance preview</legend>
      {preview.saved.v === "trellis_component_v1" ? (
        <AuthoredComponentView
          key={preview.hash}
          saved={preview.saved}
          catalog={INTERFACE_REGISTRY.catalog}
          principalKey="preview"
          canEdit={false}
          preview
          onCommit={async () => {
            throw new Error("Preview");
          }}
        />
      ) : (
        <RetainedInterfaceView
          key={preview.hash}
          saved={preview.saved}
          registry={preview.registry}
          principalKey="preview"
          canEdit={false}
          onCommit={async () => {
            throw new Error("This is a preview.");
          }}
        />
      )}
    </fieldset>
  );
}
export function SaveComponentTemplate({
  saved,
  registry,
  componentId,
  principal,
  canEdit,
}: {
  saved: RetainedInterface | AuthoredComponent;
  registry: InterfaceRegistry;
  componentId: string;
  principal: string;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    setOpen(false);
    setMessage("");
  }, [principal]);
  return (
    <>
      <button
        type="button"
        disabled={!canEdit}
        onClick={() => {
          setOpen(true);
          setMessage("");
        }}
      >
        Save as template
      </button>
      {message && <span role="status">{message}</span>}
      {open && (
        <SaveTemplateForm
          key={principal}
          saved={saved}
          registry={registry}
          componentId={componentId}
          canEdit={canEdit}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setMessage("Template saved to the workspace library.");
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
function SaveTemplateForm({
  saved,
  registry,
  componentId,
  canEdit,
  onClose,
  onSaved,
}: {
  saved: RetainedInterface | AuthoredComponent;
  registry: InterfaceRegistry;
  componentId: string;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const heading =
    (saved.v === "trellis_component_v1" ? saved.title : "") ||
    saved.document.nodes
      .find((n) => n.type === "Heading")
      ?.text?.map((run) => run.text)
      .join("") ||
    "My component";
  const [name, setName] = useState(heading),
    [slug, setSlug] = useState(
      heading
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64) || "my-component",
    ),
    [version, setVersion] = useState("1.0.0"),
    [description, setDescription] = useState(""),
    [tags, setTags] = useState("");
  const [preview, setPreview] = useState<
      | (Preview & {
          revision: number;
          options: ComponentTemplateOptions;
        })
      | null
    >(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const attempt = useRef<{
      hash: string;
      requestId: string;
    } | null>(null),
    write = useComponentRepositoryWriter();
  const options: ComponentTemplateOptions = useMemo(
    () => ({
      name,
      slug,
      version,
      description,
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    }),
    [name, slug, version, description, tags],
  );
  const optionsKey = canonicalJson(options);
  useEffect(() => {
    setPreview(null);
    attempt.current = null;
  }, [optionsKey]);
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      const value =
        saved.v === "trellis_component_v1"
          ? await prepareAuthoredTemplate(saved, registry.catalog, options)
          : await prepareComponentTemplate(saved, registry, options);
      setPreview({
        ...(await previewPackage(value)),
        revision: saved.document.revision,
        options,
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    if (!preview || !canEdit || canonicalJson(preview.options) !== optionsKey)
      return;
    setBusy(true);
    setError("");
    if (attempt.current?.hash !== preview.hash)
      attempt.current = {
        hash: preview.hash,
        requestId: `publish:${crypto.randomUUID()}`,
      };
    try {
      await write(attempt.current.requestId, {
        kind: "publish",
        componentId,
        sourceRevision: preview.revision,
        options: preview.options,
        previewHash: preview.hash,
        audience: "workspace",
      });
      onSaved();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("COMMIT_UNCERTAIN")) attempt.current = null;
      setError(message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <LibraryDialog title="Save component template" onClose={onClose}>
      <p className="mb-4">
        This template will be visible to everyone in this workspace. Preview the
        content and defaults before publishing.
      </p>
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        <label>
          Name
          <input
            className="block w-full rounded border bg-transparent p-2"
            value={name}
            maxLength={160}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Template slug
          <input
            className="block w-full rounded border bg-transparent p-2"
            value={slug}
            maxLength={64}
            onChange={(e) => setSlug(e.target.value)}
          />
        </label>
        <label>
          Version
          <input
            className="block w-full rounded border bg-transparent p-2"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          />
        </label>
        <label>
          Tags (comma separated)
          <input
            className="block w-full rounded border bg-transparent p-2"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </label>
        <label className="sm:col-span-2">
          Description
          <textarea
            className="block w-full rounded border bg-transparent p-2"
            value={description}
            maxLength={4000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </fieldset>
      <p className="my-3 text-sm">
        Checkboxes start unchecked. Field values and saved action output start
        empty. Source connections must be configured for each new instance.
        Private drafts stay out of the library. Published versions cannot be
        overwritten.
      </p>
      <button
        type="button"
        disabled={busy || !canEdit}
        onClick={() => void prepare()}
      >
        Preview template
      </button>
      {preview && (
        <>
          <TemplatePreview preview={preview} />
          <details>
            <summary>Shared content, defaults and actions</summary>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">
              {JSON.stringify(preview.package, null, 2)}
            </pre>
          </details>
          {preview.revision !== saved.document.revision && (
            <p role="alert">
              The source changed after this preview. Preview it again before
              publishing.
            </p>
          )}
          <button
            type="button"
            className="mt-4"
            disabled={
              busy || !canEdit || preview.revision !== saved.document.revision
            }
            onClick={() => void publish()}
          >
            {attempt.current ? "Retry publication" : "Publish to workspace"}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="mt-3">
          {error}
        </p>
      )}
    </LibraryDialog>
  );
}
export function ComponentLibraryButton({
  surfaceId,
  parentId,
}: {
  surfaceId: bigint;
  parentId: bigint | null;
}) {
  const access = usePageAccess(surfaceId),
    [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [access.principal, surfaceId]);
  return (
    <>
      <NewComponentButton surfaceId={surfaceId} parentId={parentId} />
      <button
        type="button"
        className="mb-3 rounded border px-3 py-1 text-sm"
        onClick={() => setOpen(true)}
      >
        Component library
      </button>
      {open && (
        <WorkspaceLibrary
          key={`${surfaceId}:${access.principal}`}
          surfaceId={surfaceId}
          parentId={parentId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
export function WorkspaceLibrary({
  surfaceId,
  parentId,
  onClose,
  onInsert,
}: {
  surfaceId: bigint;
  parentId: bigint | null;
  onClose: () => void;
  onInsert?: (
    descriptor: Record<string, unknown>,
    name: string,
  ) => void | Promise<void>;
}) {
  const [targetPage, setTargetPage] = useState(surfaceId);
  const access = usePageAccess(targetPage),
    { rows: families, ready } = useWorkspaceComponentTemplates(),
    write = useComponentRepositoryWriter(),
    { getConnection } = useSpacetimeDB();
  const { rows: nodes } = useScopedTable<ComponentNode>(
    tables.component_node,
    `SELECT * FROM component_node WHERE surface_id = ${targetPage}`,
    (node) => node.surfaceId === targetPage && node.deletedAt == null,
  );
  const insertionParent =
    targetPage === surfaceId && parentId != null
      ? parentId
      : nodes.find((node) => node.parentId == null)?.id;
  const [search, setSearch] = useState(""),
    [includeArchived, setIncludeArchived] = useState(false),
    [selected, setSelected] = useState(""),
    [version, setVersion] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const { rows: versions, ready: versionsReady } =
    useWorkspaceComponentVersions(selected);
  const family = families.find((row) => row.templateId === selected),
    row = versions.find((row) => row.version === version);
  const request = useRef<{
      key: string;
      id: string;
    } | null>(null),
    live = useRef(access);
  live.current = access;
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError("");
    request.current = null;
    if (!row) return;
    void (async () => {
      try {
        const value = await validateReusableComponentPackage(
            JSON.parse(row.packageJson),
            INTERFACE_REGISTRY,
          ),
          next = await previewPackage(value);
        if (next.hash !== row.contentHash)
          throw new Error(
            "The saved package hash does not match this version.",
          );
        if (!cancelled) setPreview(next);
      } catch (error) {
        if (!cancelled)
          setError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row?.packageJson, row?.contentHash]);
  const visible = families.filter(
    (row) =>
      (includeArchived || !row.archived) &&
      `${row.name} ${row.description} ${row.tagsJson}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const canManage =
    !!family &&
    (family.owner.toHexString() === access.principal || access.privileged);
  async function archive() {
    if (!family) return;
    setBusy(true);
    setError("");
    const key = `archive:${family.templateId}:${family.revision}:${!family.archived}`;
    if (request.current?.key !== key)
      request.current = { key, id: `library:${crypto.randomUUID()}` };
    try {
      await write(request.current.id, {
        kind: "archive",
        templateId: family.templateId,
        baseRevision: Number(family.revision),
        archived: !family.archived,
      });
      request.current = null;
      setMessage(
        "Library entry updated. Existing instances keep their saved version.",
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!text.includes("COMMIT_UNCERTAIN")) request.current = null;
      setError(text);
    } finally {
      setBusy(false);
    }
  }
  async function insert() {
    if (
      !preview ||
      (!onInsert && !insertionParent) ||
      !live.current.canEdit ||
      family?.archived
    )
      return;
    setBusy(true);
    setError("");
    const connection = getConnection() as DbConnection | null,
      principal = access.principal;
    const check = () => {
      if (
        !connection ||
        live.current.principal !== principal ||
        connection.identity?.toHexString() !== principal ||
        !live.current.canEdit
      )
        throw new Error("This editing session ended or page access changed.");
    };
    const descriptor =
      preview.package.format === "trellis_authored_template_v1"
        ? {
            kind: "component-template",
            templateId: preview.package.templateId,
            version: preview.package.version,
            hash: preview.hash,
          }
        : {
            templateId: preview.package.definition.template.id,
            templateVersion: preview.package.definition.template.version,
            parameters: {},
          };
    const key = canonicalJson([
      targetPage.toString(),
      insertionParent?.toString() ?? "cursor",
      descriptor,
    ]);
    if (request.current?.key !== key)
      request.current = { key, id: `library:${crypto.randomUUID()}` };
    const requestId = request.current.id;
    try {
      check();
      if (onInsert) {
        await onInsert(descriptor, family!.name);
        request.current = null;
        onClose();
        return;
      }
      const fingerprint =
        "kind" in descriptor
          ? await sha256({
              templateId: descriptor.templateId,
              version: descriptor.version,
              hash: descriptor.hash,
            })
          : await interfaceCreationFingerprint(descriptor);
      check();
      try {
        await connection!.reducers.createTrellisPanel({
          parentId: insertionParent!.toString(),
          requestId,
          parametersJson: canonicalJson(descriptor),
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (
          /lacks .*access|Authentication required|TEMPLATE_ARCHIVED|REQUEST_REUSED|TEMPLATE_NOT_FOUND/.test(
            text,
          )
        )
          throw error;
      }
      for (let attempt = 0; attempt < 25; attempt++) {
        check();
        for (const node of connection!.db.component_node.iter()) {
          if (
            node.surfaceId !== targetPage ||
            node.componentType !== "TrellisPanel" ||
            node.deletedAt != null
          )
            continue;
          let saved: RetainedInterface | AuthoredComponent;
          try {
            saved =
              preview.package.format === "trellis_authored_template_v1"
                ? readPageComponent(
                    node.props,
                    String(targetPage),
                    String(node.id),
                  )
                : readPageInterface(
                    node.props,
                    String(targetPage),
                    String(node.id),
                    preview.registry,
                  );
          } catch {
            continue;
          }
          if (
            saved.creation.principal === principal &&
            saved.creation.parentId === insertionParent!.toString() &&
            saved.creation.requestId === requestId
          ) {
            if (saved.creation.fingerprint !== fingerprint)
              throw new Error(
                "REQUEST_REUSED: Another component uses this request.",
              );
            request.current = null;
            setMessage("Component inserted with independent saved state.");
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      throw new Error(
        "COMMIT_UNCERTAIN: The new instance has not arrived. Retry the same insertion.",
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!text.includes("COMMIT_UNCERTAIN")) request.current = null;
      setError(text);
    } finally {
      setBusy(false);
    }
  }
  return (
    <LibraryDialog title="Workspace component library" onClose={onClose}>
      <p className="mb-5 text-sm text-neutral-500">
        Build once, reuse across your workspace. Each insertion starts with
        fresh state and asks you to connect its data.
      </p>
      <div className="flex flex-wrap items-center gap-3 border-b border-neutral-200 pb-4 dark:border-neutral-700">
        <label className="flex-1 text-xs">
          Search components
          <input
            className="mt-1 block w-full rounded-lg border border-neutral-300 bg-transparent p-2.5 text-sm dark:border-neutral-600"
            placeholder="Search names, descriptions, or tags…"
            value={search}
            maxLength={160}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />{" "}
          Show archived
        </label>
      </div>
      <div className="grid gap-6 pt-5 sm:grid-cols-[minmax(150px,1fr)_minmax(0,2fr)]">
        <nav aria-label="Workspace templates">
          {!ready ? (
            <p role="status">Loading component library…</p>
          ) : !visible.length ? (
            <p className="py-6 text-sm text-neutral-500">
              No matching templates. Insert a blank component using /, then
              choose “Save as template” from its menu.
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map((row) => (
                <li key={row.templateId}>
                  <button
                    type="button"
                    aria-label={row.name + (row.archived ? " (archived)" : "")}
                    aria-pressed={selected === row.templateId}
                    className={`w-full rounded-lg border p-3 text-left ${selected === row.templateId ? "border-violet-400 bg-violet-500/10" : "border-neutral-200 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"}`}
                    disabled={busy}
                    onClick={() => {
                      setSelected(row.templateId);
                      setVersion(row.latestVersion);
                      setMessage("");
                    }}
                  >
                    <span className="block text-sm font-medium">
                      {row.name}
                      {row.archived ? " (archived)" : ""}
                    </span>
                    <span className="mt-1 block text-xs text-neutral-500">
                      {row.description || `Version ${row.latestVersion}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
        {family ? (
          <section aria-label="Selected component template" className="min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">{family.name}</h3>
                <p className="mt-1 text-sm text-neutral-500">
                  {family.description}
                </p>
              </div>
              <label className="text-xs">
                Template version
                <select
                  className="ml-2 rounded border bg-transparent p-1.5"
                  disabled={busy}
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                >
                  {[...versions]
                    .sort((a, b) =>
                      compareComponentTemplateVersions(b.version, a.version),
                    )
                    .map((row) => (
                      <option key={row.version} value={row.version}>
                        {row.version}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            {!versionsReady && <p role="status">Loading this template…</p>}
            {preview && (
              <>
                <TemplatePreview preview={preview} />
                {surfaceId === 0n && (
                  <label className="mb-4 block text-xs">
                    Insert into page
                    <select
                      className="mt-1 block w-full rounded border bg-transparent p-2 text-sm"
                      disabled={busy}
                      value={targetPage.toString()}
                      onChange={(e) => {
                        setTargetPage(BigInt(e.target.value));
                        request.current = null;
                        setMessage("");
                      }}
                    >
                      <option value="0">Choose a page…</option>
                      {access.pages
                        .filter((page) => page.pageType.tag === "Doc")
                        .map((page) => (
                          <option key={String(page.id)} value={String(page.id)}>
                            {page.title || "Untitled"}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <button
                  type="button"
                  className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                  disabled={
                    busy ||
                    !access.canEdit ||
                    (!onInsert && !insertionParent) ||
                    family.archived
                  }
                  onClick={() => void insert()}
                >
                  {request.current?.key.startsWith("[")
                    ? "Retry insertion"
                    : onInsert
                      ? "Insert at cursor"
                      : "Insert into this page"}
                </button>
                {!access.canEdit && targetPage !== 0n && (
                  <p className="mt-2 text-xs text-neutral-500">
                    Choose a page you can edit to insert this component.
                  </p>
                )}
              </>
            )}
            {canManage && (
              <div className="mt-5 border-t border-neutral-200 pt-3 dark:border-neutral-700">
                <button
                  type="button"
                  className="text-xs text-neutral-500 underline"
                  disabled={busy}
                  onClick={() => void archive()}
                >
                  {family.archived ? "Restore template" : "Archive template"}
                </button>
              </div>
            )}
            {family.archived && (
              <p className="mt-3 text-xs">
                This template is archived. Existing instances keep working.
              </p>
            )}
          </section>
        ) : (
          <div className="flex min-h-60 items-center justify-center rounded-lg border border-dashed border-neutral-300 p-8 text-sm text-neutral-500 dark:border-neutral-700">
            Select a template to preview it.
          </div>
        )}
      </div>
      {message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm">
          {error}
        </p>
      )}
    </LibraryDialog>
  );
}
