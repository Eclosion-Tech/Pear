import { describe, it, expect } from "vitest";
import { canonicalJson, createRetainedInterface, commitRetainedInterface, prepareComponentTemplate, componentTemplateReference, componentRepositoryFingerprint, type RetainedInterface, type InterfaceRegistry } from "@eclosion-tech/trellis";
import { INTERFACE_REGISTRY } from "@pear/trellis-ui";
import { COMPONENT_REPOSITORY_TOOLS } from "./component-repository-tools";
import { PAGE_PANEL_TOOLS } from "./page-panels";
import { toolFilterForScopes } from "../mcp-oauth/scopes";
import type { McpContext } from "./types";
const principal = "a".repeat(64), options = { slug: "release-checklist", version: "1.0.0", name: "Release checklist", description: "Ship with confidence.", tags: ["release"] };
async function fixture() {
    const source = await createRetainedInterface({ templateId: "trellis.checklist", templateVersion: "1.0.0", parameters: {} }, { registry: INTERFACE_REGISTRY, principal, parentId: "70", requestId: "source", documentId: "pear-page:7:component:100", instanceId: "pear-component:100" });
    const panels = new Map<string, RetainedInterface>([["100", source]]), versions = new Map<string, any>(), receipts = new Map<string, any>();
    let family: any = null, lose = false, denied = false, forced = "";
    const calls: {
        name: string;
        args: unknown[];
    }[] = [];
    const registry = (): InterfaceRegistry => ({ catalog: INTERFACE_REGISTRY.catalog, definitions: [...INTERFACE_REGISTRY.definitions, ...[...versions.values()].map(row => JSON.parse(row.package_json).definition)] });
    const rows = () => [...panels].map(([id, saved]) => ({ id, surface_id: "7", component_type: "TrellisPanel", props: canonicalJson(saved), deleted_at: null }));
    const transport = {
        sql: async (query: string) => {
            if (query.includes("ai_user_config"))
                return [{ identity: principal }];
            if (query.includes("my_component_repository_receipt")) {
                const id = /request_id = '([^']+)'/.exec(query)?.[1];
                return id && receipts.has(id) ? [receipts.get(id)] : [];
            }
            if (query.includes("workspace_component_template_version")) {
                const id = /template_id = '([^']+)'/.exec(query)?.[1], version = /version = '([^']+)'/.exec(query)?.[1];
                return [...versions.values()].filter(row => (!id || row.template_id === id) && (!version || row.version === version));
            }
            if (query.includes("workspace_component_template"))
                return family ? [family] : [];
            if (query.includes("component_node")) {
                if (query.includes("WHERE id = 70"))
                    return [{ id: "70", surface_id: "7", component_type: "Container", props: "{}", deleted_at: null }];
                const id = /WHERE id = (\d+)/.exec(query)?.[1];
                return rows().filter(row => !id || row.id === id);
            }
            throw new Error(`Unexpected query: ${query}`);
        },
        call: async (name: string, args: unknown[]) => {
            calls.push({ name, args });
            if (denied)
                throw new Error("Caller lacks write access on this page");
            if (forced)
                throw new Error(forced);
            if (name === "publish_component_template") {
                const [id, revision, rawOptions, hash, audience, requestId] = args as [
                    string,
                    number,
                    string,
                    string,
                    string,
                    string
                ];
                const settings = JSON.parse(rawOptions), command = { kind: "publish" as const, componentId: id, sourceRevision: revision, options: settings, previewHash: hash, audience: "workspace" as const }, fingerprint = await componentRepositoryFingerprint(command);
                if (receipts.has(requestId)) {
                    if (receipts.get(requestId).fingerprint !== fingerprint)
                        throw new Error("REQUEST_REUSED: Different intent");
                    return;
                }
                const value = await prepareComponentTemplate(panels.get(id)!, registry(), settings), reference = await componentTemplateReference(value);
                expect(audience).toBe("workspace");
                expect(reference.hash).toBe(hash);
                versions.set(`${reference.templateId}@${reference.version}`, { template_id: reference.templateId, version: reference.version, package_json: canonicalJson(value), content_hash: reference.hash });
                family = { template_id: reference.templateId, name: settings.name, description: settings.description, tags_json: JSON.stringify(settings.tags), owner: principal, latest_version: reference.version, archived: false, revision: 0 };
                receipts.set(requestId, { fingerprint, template_id: reference.templateId, operation: "publish", result_revision: 0 });
            }
            else if (name === "archive_component_template") {
                const [templateId, baseRevision, archived, requestId] = args as [
                    string,
                    number,
                    boolean,
                    string
                ], fingerprint = await componentRepositoryFingerprint({ kind: "archive", templateId, baseRevision, archived });
                family = { ...family, archived, revision: family.revision + 1 };
                receipts.set(requestId, { fingerprint, template_id: templateId, operation: "archive", result_revision: family.revision });
            }
            else if (name === "create_trellis_panel") {
                const [parentId, requestId, descriptor] = args as string[], id = String(100 + panels.size);
                panels.set(id, await createRetainedInterface(JSON.parse(descriptor), { registry: registry(), principal, parentId, requestId, documentId: `pear-page:7:component:${id}`, instanceId: `pear-component:${id}` }));
            }
            else if (name === "commit_trellis_panel") {
                const [id, baseRevision, requestId, command] = args as [
                    string,
                    number,
                    string,
                    string
                ];
                panels.set(id, await commitRetainedInterface(panels.get(id)!, { baseRevision, requestId, command: JSON.parse(command) }, { registry: registry(), principal }));
            }
            else
                throw new Error(`Unexpected reducer: ${name}`);
            if (lose)
                throw new Error("Network disconnected after the commit");
        },
    };
    const ctx = { aiUserId: 1n, transport } as unknown as McpContext;
    return { run: async (name: string, input: Record<string, unknown>) => JSON.parse(await [...COMPONENT_REPOSITORY_TOOLS, ...PAGE_PANEL_TOOLS].find(t => t.name === name)!.execute(ctx, input)), calls, panels, versions, receipts, lose: () => { lose = true; }, deny: () => { denied = true; }, force: (message: string) => { forced = message; } };
}
describe("workspace repository authoring through shared MCP/chat tools", () => {
    it("previews, publishes, discovers and instantiates a custom layout without registry code changes", async () => {
        const host = await fixture();
        await host.run("update_page_panel", { component_id: "100", base_revision: 0, request_id: "add-task", operations: [{ op: "insertNode", node: { id: "ship-test", parentId: host.panels.get("100")!.document.rootId, order: 0, type: "ChecklistItem", props: { checked: true }, text: [{ text: "Ship a test" }], action: { slot: "checklist.toggle", input: {} } } }] });
        const preview = await host.run("preview_component_template", { component_id: "100", options });
        expect(preview.ok).toBe(true);
        expect(preview.source_revision).toBe(1);
        expect(host.versions.size).toBe(0);
        expect(preview.visibility).toContain("all workspace members");
        host.lose();
        const request = { component_id: "100", source_revision: preview.source_revision, options, preview_hash: preview.preview_hash, audience: "workspace", request_id: "publish" };
        const published = await host.run("publish_component_template", request);
        expect(published.ok).toBe(true);
        expect(published.reference.templateId).toBe("workspace:release-checklist");
        expect((await host.run("publish_component_template", request)).ok).toBe(true);
        expect(host.versions.size).toBe(1);
        expect((await host.run("list_component_templates", { search: "release" })).templates[0].template_id).toBe("workspace:release-checklist");
        expect((await host.run("list_component_templates", { search: "absent" })).templates).toEqual([]);
        const read = await host.run("get_component_template", { template_id: "workspace:release-checklist", version: "1.0.0" });
        expect(read.reference.hash).toBe(preview.preview_hash);
        expect((await host.run("list_page_panel_templates", {})).templates.some((t: any) => t.id === "workspace:release-checklist")).toBe(true);
        const a = await host.run("create_page_panel", { parent_id: "70", template_id: "workspace:release-checklist", template_version: "1.0.0", parameters: { title: "Release A" }, request_id: "first-use" });
        const b = await host.run("create_page_panel", { parent_id: "70", template_id: "workspace:release-checklist", template_version: "1.0.0", parameters: { title: "Release B" }, request_id: "second-use" });
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
        expect(a.component_id).not.toBe(b.component_id);
        expect(a.document.nodes.filter((n: any) => n.type === "ChecklistItem").every((n: any) => n.props.checked === false)).toBe(true);
        expect(a.document.nodes.every((n: any) => !b.document.nodes.some((other: any) => other.id === n.id))).toBe(true);
        const changed = await host.run("update_page_panel", { component_id: a.component_id, base_revision: 0, request_id: "edit-instance", operations: [{ op: "setText", target: { key: "title" }, text: [{ text: "Changed just A" }] }] });
        expect(changed.ok).toBe(true);
        expect((await host.run("get_page_panel", { component_id: b.component_id })).document.nodes.some((n: any) => n.text?.[0]?.text === "Release B")).toBe(true);
        const archived = await host.run("archive_component_template", { template_id: "workspace:release-checklist", base_revision: 0, archived: true, request_id: "archive" });
        expect(archived.ok).toBe(true);
        expect((await host.run("list_component_templates", {})).templates).toEqual([]);
        expect((await host.run("list_component_templates", { include_archived: true })).templates).toHaveLength(1);
        expect((await host.run("get_page_panel", { component_id: a.component_id })).ok).toBe(true);
    });
    it("retains authoritative stale/permission/preview errors and rejects malformed inputs before writing", async () => {
        const host = await fixture(), preview = await host.run("preview_component_template", { component_id: "100", options });
        const request = { component_id: "100", source_revision: 0, options, preview_hash: preview.preview_hash, audience: "workspace", request_id: "publish" };
        expect((await host.run("publish_component_template", { ...request, audience: "public" })).code).toBe("INVALID_INPUT");
        expect((await host.run("publish_component_template", { ...request, source_revision: null })).code).toBe("UNSAFE_REVISION");
        expect(host.calls).toHaveLength(0);
        for (const code of ["STALE_REVISION", "PREVIEW_CHANGED", "IMMUTABLE_VERSION"]) {
            host.force(`${code}: authoritative rejection`);
            expect((await host.run("publish_component_template", request)).code).toBe(code);
            expect(host.versions.size).toBe(0);
        }
        host.force("");
        host.deny();
        expect((await host.run("publish_component_template", request)).code).toBe("AUTHORIZATION_DENIED");
        expect(host.receipts.size).toBe(0);
    });
    it("keeps repository writes out of read-only and default memory OAuth grants", () => {
        const read = toolFilterForScopes(["pages:read"]), write = toolFilterForScopes(["pages:write"]), memory = toolFilterForScopes(["memory"]);
        for (const name of ["list_component_templates", "get_component_template"]) {
            expect(read(name)).toBe(true);
            expect(memory(name)).toBe(false);
        }
        for (const name of ["preview_component_template", "publish_component_template", "archive_component_template"]) {
            expect(read(name)).toBe(false);
            expect(memory(name)).toBe(false);
            expect(write(name)).toBe(true);
        }
    });
});
