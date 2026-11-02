"use client";
import { useCallback, useMemo, useRef } from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import { canonicalJson, componentRepositoryFingerprint, type ComponentRepositoryCommand, type ComponentTemplatePackage, type InterfaceRegistry } from "@eclosion-tech/trellis";
import { INTERFACE_REGISTRY, PanelCommitError } from "@pear/trellis-ui";
import { tables, type DbConnection } from "@/src/module_bindings";
import type { ComponentTemplateFamily as WorkspaceComponentTemplate, ComponentTemplateVersion as WorkspaceComponentTemplateVersion } from "@/src/module_bindings/types";
import { useScopedTable } from "./useScopedTable";
export function useWorkspaceComponentTemplates() {
    return useScopedTable<WorkspaceComponentTemplate>(tables.workspace_component_template, "SELECT * FROM workspace_component_template", () => true);
}
export function useWorkspaceComponentVersions(templateId: string) {
    const escaped = templateId.replaceAll("'", "''");
    return useScopedTable<WorkspaceComponentTemplateVersion>(tables.workspace_component_template_version, `SELECT * FROM workspace_component_template_version WHERE template_id = '${escaped}'`, row => row.templateId === templateId);
}
export function usePageInterfaceRegistry(props: string): {
    registry: InterfaceRegistry;
    ready: boolean;
    error: string;
    templateName?: string;
} {
    const origin = useMemo(() => { try {
        return JSON.parse(props)?.document?.template;
    }
    catch {
        return null;
    } }, [props]);
    const id = typeof origin?.id === "string" && origin.id.startsWith("workspace:") ? origin.id : "";
    const { rows, ready } = useWorkspaceComponentVersions(id);
    return useMemo(() => {
        if (!id)
            return { registry: INTERFACE_REGISTRY, ready: true, error: "" };
        const row = rows.find(row => row.version === origin.version);
        if (!row)
            return { registry: INTERFACE_REGISTRY, ready, error: ready ? "This component's pinned template is unavailable. Its saved data has been retained." : "" };
        try {
            // The database generated and validated this immutable package at publication.
            // Remote packages must pass adoption validation before reaching this table.
            const value = JSON.parse(row.packageJson) as ComponentTemplatePackage;
            if (value.format !== "trellis_component_template_v1" || value.repositoryId !== "workspace" || value.definition.template.id !== id || value.definition.template.version !== origin.version)
                throw new Error("Invalid pinned package");
            const registry: InterfaceRegistry = { catalog: INTERFACE_REGISTRY.catalog, definitions: [...INTERFACE_REGISTRY.definitions, value.definition] };
            return { registry, ready, error: "", templateName: value.name };
        }
        catch {
            return { registry: INTERFACE_REGISTRY, ready, error: "This component's pinned template is invalid. Its saved data has been retained." };
        }
    }, [id, origin?.version, rows, ready]);
}
export function useComponentRepositoryWriter() {
    const { getConnection, identity } = useSpacetimeDB(), principal = identity?.toHexString() ?? "anonymous";
    const live = useRef(principal);
    live.current = principal;
    useScopedTable(tables.workspace_component_repository_receipt, "SELECT * FROM my_component_repository_receipt", () => true);
    return useCallback(async (requestId: string, command: ComponentRepositoryCommand) => {
        const connection = getConnection() as DbConnection | null, author = principal;
        const check = () => { if (author === "anonymous" || live.current !== author || connection?.identity?.toHexString() !== author)
            throw new PanelCommitError("SESSION_ENDED", "This editing session ended."); };
        check();
        const fingerprint = await componentRepositoryFingerprint(command);
        check();
        let errorMessage = "";
        try {
            if (command.kind === "publish")
                await connection!.reducers.publishComponentTemplate({ sourceComponentId: command.componentId, sourceRevision: BigInt(command.sourceRevision), optionsJson: canonicalJson(command.options), expectedHash: command.previewHash, audience: command.audience, requestId });
            else
                await connection!.reducers.archiveComponentTemplate({ templateId: command.templateId, baseRevision: BigInt(command.baseRevision), archived: command.archived, requestId });
        }
        catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error);
            if (/lacks .*access|Authentication required|Only the creator|STALE_REVISION|PREVIEW_CHANGED|REQUEST_REUSED|IMMUTABLE_VERSION|TEMPLATE_ARCHIVED|INVALID_TEMPLATE|PANEL_UNAVAILABLE|TEMPLATE_NOT_FOUND|INVALID_INTERFACE|TEMPLATE_PINNED|UNSUPPORTED_CAPABILITY|IMPORT_IN_PROGRESS|LIMIT:/.test(errorMessage))
                throw error;
        }
        for (let attempt = 0; attempt < 25; attempt++) {
            check();
            const receipt = [...connection!.db.workspace_component_repository_receipt.iter()].find(row => row.requestId === requestId);
            if (receipt) {
                if (receipt.fingerprint !== fingerprint || receipt.operation !== command.kind)
                    throw new PanelCommitError("REQUEST_REUSED", "Repository receipt belongs to different arguments.");
                return { templateId: receipt.templateId, committedRevision: Number(receipt.resultRevision) };
            }
            await new Promise(resolve => setTimeout(resolve, 40));
        }
        throw new PanelCommitError("COMMIT_UNCERTAIN", `The saved receipt has not arrived. Retry the same request. ${errorMessage}`);
    }, [getConnection, principal]);
}
