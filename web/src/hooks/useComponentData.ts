"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createExternalJsonAdapter,
  type AuthoredComponent,
  type ComponentCommit,
  type ComponentDataAdapter,
  type ComponentSource,
  type ComponentDataSnapshot,
} from "@eclosion-tech/trellis";
import { tables } from "@/src/module_bindings";
import type {
  DatabaseSchema,
  PageAccessRule,
  PagePropertyValue,
  PropertyDefinition,
} from "@/src/module_bindings/types";
import { useScopedTable } from "./useScopedTable";
import { usePageAccess } from "./usePageAccess";
import {
  scalarProperty,
  writableProperty,
  workspaceComponentSnapshot,
} from "@/src/lib/component-workspace-data";
import type { ComponentSourceChoices } from "@eclosion-tech/trellis-react";
export function useComponentData(
  surfaceId: bigint,
  commit: (
    request: ComponentCommit,
    signal: AbortSignal,
  ) => Promise<AuthoredComponent>,
  read: () => AuthoredComponent,
) {
  const access = usePageAccess(surfaceId);
  const schemas = useScopedTable<DatabaseSchema>(
    tables.database_schema,
    "SELECT * FROM database_schema",
    () => true,
  );
  const properties = useScopedTable<PropertyDefinition>(
    tables.property_definition,
    "SELECT * FROM property_definition",
    () => true,
  );
  const values = useScopedTable<PagePropertyValue>(
    tables.page_property_value,
    "SELECT * FROM page_property_value",
    () => true,
  );
  const rules = useScopedTable<PageAccessRule>(
    tables.page_access_rule,
    "SELECT * FROM page_access_rule",
    () => true,
  );
  const data = {
    ...access,
    ready:
      access.ready &&
      schemas.ready &&
      properties.ready &&
      values.ready &&
      rules.ready,
    schemas: schemas.rows,
    properties: properties.rows,
    values: values.rows,
    rules: rules.rows,
  };
  const live = useRef({ data, commit, read });
  live.current = { data, commit, read };
  const listeners = useRef(
    new Set<{
      source: ComponentSource;
      deliver: (value: ComponentDataSnapshot) => void;
    }>(),
  );
  useEffect(() => {
    for (const listener of listeners.current)
      listener.deliver(workspaceComponentSnapshot(listener.source, data));
  }, [
    access.pages,
    access.principal,
    access.ready,
    access.privileged,
    schemas.rows,
    schemas.ready,
    properties.rows,
    properties.ready,
    values.rows,
    values.ready,
    rules.rows,
    rules.ready,
  ]);
  const workspace = useMemo<ComponentDataAdapter>(() => {
    const attempts = new Map<string, ComponentCommit>();
    return {
      subscribe(source, deliver, signal) {
        const listener = { source, deliver };
        listeners.current.add(listener);
        deliver(workspaceComponentSnapshot(source, live.current.data));
        const close = () => listeners.current.delete(listener);
        signal.addEventListener("abort", close, { once: true });
        return () => {
          close();
          signal.removeEventListener("abort", close);
        };
      },
      refresh: async (source) =>
        workspaceComponentSnapshot(source, live.current.data),
      async create(source, intent, context) {
        let request = attempts.get(intent.requestId);
        if (!request) {
          request = {
            baseRevision: intent.event.revision,
            requestId: intent.requestId,
            command: { kind: "source-create", event: intent.event },
          };
          attempts.set(intent.requestId, request);
        }
        const saved = await live.current.commit(request, context.signal),
          receipt = saved.receipts.find(
            (receipt) =>
              receipt.requestId === intent.requestId &&
              receipt.principal === live.current.data.principal,
          );
        if (!receipt?.recordId)
          throw new Error(
            "COMMIT_UNCONFIRMED: The created record receipt has not arrived. Retry the same submission.",
          );
        const deadline = Date.now() + 2500;
        do {
          if (context.signal.aborted)
            throw new Error("SESSION_ENDED: This connection ended.");
          const snapshot = workspaceComponentSnapshot(
              source,
              live.current.data,
            ),
            row = snapshot.records.find((row) => row.id === receipt.recordId);
          if (
            row &&
            Object.entries(intent.values).every(
              ([key, value]) => row.values[key] === value,
            )
          )
            return { status: "confirmed", record: row };
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        return {
          status: "uncertain",
          message:
            "Creation receipt arrived, but the source record is not visible yet. Keep these inputs and retry the same submission.",
        };
      },
      async write(source, write, context) {
        let request = attempts.get(write.requestId);
        if (!request) {
          request = {
            baseRevision: live.current.read().document.revision,
            requestId: write.requestId,
            command: { kind: "source-write", write },
          };
          attempts.set(write.requestId, request);
        }
        await live.current.commit(request, context.signal);
        const deadline = Date.now() + 2500;
        do {
          if (context.signal.aborted)
            throw new Error("SESSION_ENDED: This connection ended.");
          const row = workspaceComponentSnapshot(
            source,
            live.current.data,
          ).records.find((row) => row.id === write.recordId);
          if (
            row &&
            Object.entries(write.values).every(
              ([key, value]) => row.values[key] === value,
            )
          )
            return { status: "confirmed", record: row };
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        return {
          status: "uncertain",
          message:
            "The component receipt arrived, but the updated source record is not visible yet. Retry the same source write.",
        };
      },
    };
  }, [access.principal]);
  const credentials = useMemo(
      () => new Map<string, string>(),
      [access.principal],
    ),
    [credentialRevision, setCredentialRevision] = useState(0);
  useEffect(() => () => credentials.clear(), [credentials]);
  const onCredential = useCallback(
    (origin: string, token: string) => {
      if (token) credentials.set(origin, token);
      else credentials.delete(origin);
      setCredentialRevision((value) => value + 1);
    },
    [credentials],
  );
  const external = useMemo(
    () =>
      createExternalJsonAdapter({
        headers: async (origin): Promise<Record<string, string>> => {
          const token = credentials.get(origin);
          return token ? { Authorization: `Bearer ${token}` } : {};
        },
      }),
    [credentials, credentialRevision],
  );
  const choices: ComponentSourceChoices = {
    databases: schemas.rows
      .filter((schema) =>
        access.pages.some((page) => page.id === schema.pageId),
      )
      .map((schema) => ({
        id: schema.id.toString(),
        name: schema.name,
        properties: properties.rows
          .filter(
            (property) =>
              property.schemaId === schema.id &&
              scalarProperty(property.propertyType.tag),
          )
          .map((property) => ({
            id: property.id.toString(),
            name: property.name,
            type: scalarProperty(property.propertyType.tag)!,
            writable: writableProperty(property.propertyType.tag),
          })),
      })),
  };
  const dataAdapters = useMemo(
    () => ({ "pear.database": workspace, "external.json": external }),
    [workspace, external],
  );
  return { dataAdapters, sourceChoices: choices, onCredential };
}
