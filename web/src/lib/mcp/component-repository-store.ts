import { INTERFACE_REGISTRY, panelId, PanelCommitError } from "@pear/trellis-ui";
import { canonicalJson, validateReusableComponentPackage, reusableComponentReference, componentRepositoryFingerprint, type InterfaceRegistry, type ComponentRepositoryCommand, type ComponentTemplatePackage } from "@eclosion-tech/trellis";
import type { StdbTransport } from "./types";
import { reducerErrorMessage } from "./errors";
export const sqlText = (value: string) => `'${value.replaceAll("'", "''")}'`;
export type WorkspaceTemplateFamily = {
    template_id: string;
    name: string;
    description: string;
    tags_json: string;
    owner: unknown;
    latest_version: string;
    archived: boolean;
    revision: unknown;
};
export function safeRevision(value: unknown): number {
    if (typeof value !== "number" && !(typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)))
        throw new PanelCommitError("UNSAFE_REVISION", "Expected a nonnegative safe revision.");
    const revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision < 0)
        throw new PanelCommitError("UNSAFE_REVISION", "Expected a nonnegative safe revision.");
    return revision;
}
export function workspaceTemplateId(value: unknown): string {
    if (typeof value !== "string" || !/^workspace:[a-z][a-z0-9-]{0,63}$/.test(value))
        throw new PanelCommitError("INVALID_TEMPLATE", "Use an exact workspace:<slug> template ID from the component library.");
    return value;
}
export async function workspaceTemplateFamilies(transport: StdbTransport, includeArchived = false): Promise<WorkspaceTemplateFamily[]> {
    const rows = await transport.sql<WorkspaceTemplateFamily>("SELECT template_id, name, description, tags_json, owner, latest_version, archived, revision FROM workspace_component_template");
    return rows.filter(row => includeArchived || !row.archived).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
export async function workspaceTemplateFamily(transport: StdbTransport, id: string): Promise<WorkspaceTemplateFamily> {
    workspaceTemplateId(id);
    const rows = await transport.sql<WorkspaceTemplateFamily>(`SELECT template_id, name, description, tags_json, owner, latest_version, archived, revision FROM workspace_component_template WHERE template_id = ${sqlText(id)}`);
    if (rows.length !== 1)
        throw new PanelCommitError("TEMPLATE_NOT_FOUND", "The workspace component template is unavailable or unreadable.");
    return rows[0];
}
export async function workspaceTemplate(transport: StdbTransport, id: string, version: string) {
    workspaceTemplateId(id);
    if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version))
        throw new PanelCommitError("INVALID_TEMPLATE", "Use an exact major.minor.patch version.");
    const rows = await transport.sql<{
        package_json: string;
        content_hash: string;
    }>(`SELECT package_json, content_hash FROM workspace_component_template_version WHERE template_id = ${sqlText(id)} AND version = ${sqlText(version)}`);
    if (rows.length !== 1)
        throw new PanelCommitError("TEMPLATE_NOT_FOUND", "The exact workspace component version is unavailable or unreadable.");
    const packageValue = await validateReusableComponentPackage(JSON.parse(rows[0].package_json), INTERFACE_REGISTRY);
    const reference = await reusableComponentReference(packageValue);
    if (reference.repositoryId !== "workspace" || reference.templateId !== id || reference.version !== version || reference.hash !== rows[0].content_hash)
        throw new PanelCommitError("TEMPLATE_PINNED", "Saved component package does not match its exact repository coordinate.");
    return { package: packageValue, reference };
}
export async function panelRegistry(transport: StdbTransport, id: string, version: string, creating = false): Promise<InterfaceRegistry> {
    if (!id.startsWith("workspace:"))
        return INTERFACE_REGISTRY;
    if (creating && (await workspaceTemplateFamily(transport, id)).archived)
        throw new PanelCommitError("TEMPLATE_ARCHIVED", "This component template is archived. Existing instances remain available.");
    const value = await workspaceTemplate(transport, id, version);
    if(value.package.format!=="trellis_component_template_v1")throw new PanelCommitError("USE_COMPONENT_AUTHORING", "Use create_component to instantiate this authored template.");
    return { catalog: INTERFACE_REGISTRY.catalog, definitions: [...INTERFACE_REGISTRY.definitions, value.package.definition] };
}
export async function observeRepositoryCommand(transport: StdbTransport, requestId: string, command: ComponentRepositoryCommand) {
    const fingerprint = await componentRepositoryFingerprint(command);
    const args = command.kind === "publish" ? [panelId(command.componentId), command.sourceRevision, canonicalJson(command.options), command.previewHash, command.audience, requestId]
        : [workspaceTemplateId(command.templateId), command.baseRevision, command.archived, requestId];
    let transportError: unknown;
    try {
        await transport.call(command.kind === "publish" ? "publish_component_template" : "archive_component_template", args);
    }
    catch (error) {
        const message = reducerErrorMessage(error);
        if (/lacks .*access|Authentication required|Only the creator|not found/i.test(message))
            throw new PanelCommitError("AUTHORIZATION_DENIED", message);
        const code = /\b(STALE_REVISION|REQUEST_REUSED|PREVIEW_CHANGED|IMMUTABLE_VERSION|TEMPLATE_ARCHIVED|INVALID_TEMPLATE|INVALID_COMPONENT|INVALID_BINDING|PANEL_UNAVAILABLE|TEMPLATE_NOT_FOUND|INVALID_INTERFACE|TEMPLATE_PINNED|UNSUPPORTED_CAPABILITY|IMPORT_IN_PROGRESS|LIMIT):/.exec(message)?.[1];
        if (code)
            throw new PanelCommitError(code, message);
        transportError = error;
    }
    for (let attempt = 0; attempt < 12; attempt++) {
        const rows = await transport.sql<{
            fingerprint: string;
            template_id: string;
            operation: string;
            result_revision: unknown;
        }>(`SELECT fingerprint, template_id, operation, result_revision FROM my_component_repository_receipt WHERE request_id = ${sqlText(requestId)}`);
        const receipt = rows[0];
        if (receipt) {
            if (receipt.fingerprint !== fingerprint || receipt.operation !== command.kind)
                throw new PanelCommitError("REQUEST_REUSED", "Repository receipt belongs to different arguments.");
            return { templateId: receipt.template_id, committedRevision: safeRevision(receipt.result_revision) };
        }
        await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new PanelCommitError("COMMIT_UNCERTAIN", `No durable repository receipt observed. Retry with the identical request_id and arguments. ${transportError instanceof Error ? transportError.message : ""}`);
}
