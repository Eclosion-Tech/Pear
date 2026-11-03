import { canonicalJson, reusableComponentReference, prepareAuthoredTemplate, prepareComponentTemplate, validateComponentTemplateOptions, TrellisError } from "@eclosion-tech/trellis";
import { panelId, panelRequestId, PanelCommitError } from "@pear/trellis-ui";
import { getPagePanel } from "./page-panels";
import { observeRepositoryCommand, safeRevision, workspaceTemplate, workspaceTemplateFamilies, workspaceTemplateFamily, workspaceTemplateId } from "./component-repository-store";
import type { McpToolEntry } from "./types";
const optionsSchema = { type: "object", properties: { slug: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" }, version: { type: "string", description: "Exact immutable major.minor.patch version, starting with 1.0.0." }, name: { type: "string", minLength: 1, maxLength: 160 }, description: { type: "string", maxLength: 4000 }, tags: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 32 } } }, required: ["slug", "version", "name", "description", "tags"], additionalProperties: false };
const idSchema = { type: "string", description: "Positive decimal source component ID, kept as a string." };
const requestSchema = { type: "string", description: "Fresh request ID; retry uncertain writes with identical arguments and this same ID." };
function tool(entry: McpToolEntry): McpToolEntry {
    return { ...entry, async execute(ctx, input) {
            try {
                const allowed = Object.keys(entry.inputSchema.properties ?? {});
                if (Object.keys(input).some(key => !allowed.includes(key)))
                    throw new PanelCommitError("INVALID_INPUT", "Unexpected repository arguments.");
                return await entry.execute(ctx, input);
            }
            catch (error) {
                return JSON.stringify({ ok: false, code: error instanceof TrellisError || error instanceof PanelCommitError ? error.code : "INVALID_TEMPLATE", error: error instanceof Error ? error.message : String(error), ...(error instanceof TrellisError ? { path: error.path } : {}) });
            }
        } };
}
function familyResult(family: Awaited<ReturnType<typeof workspaceTemplateFamily>>) { return { repository_id: "workspace", template_id: family.template_id, name: family.name, description: family.description, tags: JSON.parse(family.tags_json), latest_version: family.latest_version, archived: family.archived, revision: safeRevision(family.revision), owner: family.owner }; }
export const COMPONENT_REPOSITORY_TOOLS: McpToolEntry[] = [
    tool({ name: "list_component_templates", description: "Discover reusable components published in this workspace. Returns metadata and exact latest versions. Use get_component_template for defaults, capabilities and the exact package hash, then create_component for an authored template or create_page_panel for a registered example. Sharing an existing saved instance in chat uses show_page_panel instead. External repositories are not connected in this version.",
        inputSchema: { type: "object", properties: { search: { type: "string", maxLength: 160 }, include_archived: { type: "boolean" } }, additionalProperties: false },
        async execute(ctx, input) {
            if (input.search !== undefined && (typeof input.search !== "string" || input.search.length > 160))
                throw new PanelCommitError("INVALID_INPUT", "Search must be bounded text.");
            if (input.include_archived !== undefined && typeof input.include_archived !== "boolean")
                throw new PanelCommitError("INVALID_INPUT", "include_archived must be boolean.");
            const search = String(input.search ?? "").toLowerCase();
            const families = await workspaceTemplateFamilies(ctx.transport, input.include_archived === true);
            return JSON.stringify({ ok: true, repository_id: "workspace", templates: families.map(familyResult).filter(item => canonicalJson([item.name, item.description, item.tags]).toLowerCase().includes(search)) });
        } }),
    tool({ name: "get_component_template", description: "Read an exact immutable workspace component package, its defaults and action policies. Archived versions remain readable for existing instances. Use the exact template_id and version when creating a fresh instance; existing page/chat references remain the same live record.",
        inputSchema: { type: "object", properties: { template_id: { type: "string" }, version: { type: "string" } }, required: ["template_id", "version"], additionalProperties: false },
        async execute(ctx, input) { const id = workspaceTemplateId(input.template_id), family = await workspaceTemplateFamily(ctx.transport, id), value = await workspaceTemplate(ctx.transport, id, String(input.version)); return JSON.stringify({ ok: true, ...familyResult(family), reference: value.reference, package: value.package, parameters: value.package.format==="trellis_component_template_v1"?value.package.definition.template.parameters:null, defaults: value.package.format==="trellis_component_template_v1"?value.package.definition.defaults:null }); } }),
    tool({ name: "preview_component_template", description: "Prepare a reusable workspace template from a saved interface without publishing it. Read the page interface first. The preview includes all shared labels/content and fresh defaults; checkbox completion, field defaults and saved action output reset. Surface drafts, source page/document identities and receipts are excluded. Inspect this preview before publish_component_template; publication requires source-page write access and an explicit workspace audience. A later source change requires a fresh preview.",
        inputSchema: { type: "object", properties: { component_id: idSchema, options: optionsSchema }, required: ["component_id", "options"], additionalProperties: false },
        async execute(ctx, input) {
            const current = await getPagePanel(ctx.transport, panelId(input.component_id));
            if (!("document" in current.state))
                throw new PanelCommitError("UNSUPPORTED_OPERATION", "Legacy Note panels must first be recreated as a registered interface.");
            const options = validateComponentTemplateOptions(input.options), value = current.state.v==="trellis_component_v1"?await prepareAuthoredTemplate(current.state,current.registry.catalog,options):await prepareComponentTemplate(current.state, current.registry, options), reference = await reusableComponentReference(value);
            return JSON.stringify({ ok: true, audience: "workspace", component_id: current.componentId, source_revision: current.state.document.revision, options, preview_hash: reference.hash, package: value, defaults: value.format==="trellis_component_template_v1"?value.definition.defaults:null, resets: ["Checkboxes start unchecked", "Field defaults and saved action output start empty", "Each use has fresh identities and independent state"], visibility: "Published templates are visible to all workspace members." });
        } }),
    tool({ name: "publish_component_template", description: "Publish the inspected preview as an immutable workspace template version. Everyone in the workspace can discover and reuse its shared content. Pass options, source_revision and preview_hash exactly as returned by preview_component_template, audience:'workspace', and a stable request_id. A stale source or changed preview is rejected. Existing versions cannot be overwritten; only the family author or an admin may publish its next version. Read again after conflicts; retry uncertain results identically.",
        inputSchema: { type: "object", properties: { component_id: idSchema, source_revision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, options: optionsSchema, preview_hash: { type: "string", pattern: "^[a-f0-9]{64}$" }, audience: { type: "string", enum: ["workspace"] }, request_id: requestSchema }, required: ["component_id", "source_revision", "options", "preview_hash", "audience", "request_id"], additionalProperties: false },
        async execute(ctx, input) {
            if (input.audience !== "workspace" || typeof input.preview_hash !== "string" || !/^[a-f0-9]{64}$/.test(input.preview_hash))
                throw new PanelCommitError("INVALID_INPUT", "Pass the inspected preview hash and explicit workspace audience.");
            const options = validateComponentTemplateOptions(input.options), receipt = await observeRepositoryCommand(ctx.transport, panelRequestId(input.request_id), { kind: "publish", componentId: panelId(input.component_id), sourceRevision: safeRevision(input.source_revision), options, previewHash: input.preview_hash, audience: "workspace" });
            const value = await workspaceTemplate(ctx.transport, receipt.templateId, options.version);
            return JSON.stringify({ ok: true, saved: true, reference: value.reference, committed_revision: receipt.committedRevision, template: familyResult(await workspaceTemplateFamily(ctx.transport, receipt.templateId)), next: "Use create_component with this exact template reference for an independent authored instance; registered examples use create_page_panel." });
        } }),
    tool({ name: "archive_component_template", description: "Archive or restore a workspace template family as its author or an admin. Archiving hides it from normal discovery and prevents new instances, while preserving pinned versions and existing page/chat instances. Supply the current library revision and a stable request_id; uncertain retries must be identical.",
        inputSchema: { type: "object", properties: { template_id: { type: "string" }, base_revision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, archived: { type: "boolean" }, request_id: requestSchema }, required: ["template_id", "base_revision", "archived", "request_id"], additionalProperties: false },
        async execute(ctx, input) { if (typeof input.archived !== "boolean")
            throw new PanelCommitError("INVALID_INPUT", "archived must be boolean."); const receipt = await observeRepositoryCommand(ctx.transport, panelRequestId(input.request_id), { kind: "archive", templateId: workspaceTemplateId(input.template_id), baseRevision: safeRevision(input.base_revision), archived: input.archived }); return JSON.stringify({ ok: true, saved: true, committed_revision: receipt.committedRevision, template: familyResult(await workspaceTemplateFamily(ctx.transport, receipt.templateId)) }); } }),
];
