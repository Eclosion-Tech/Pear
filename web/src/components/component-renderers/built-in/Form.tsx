"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { BlockRendererProps } from "@eclosion-tech/pulp";
import { useChildPages, useCreatePage, useSetPropertyValue } from "@/src/hooks/usePages";
import { useDatabaseSchema } from "@/src/hooks/useDatabase";
import {
  FormContextProvider,
  useFormFieldRegistry,
  useFormSubmitState,
} from "../FormContext";

/**
 * Built-in `Form` — data-bound form shell with submit wiring.
 *
 * Prop schema (`prop_schemas::FORM` in components.rs):
 *   { databaseId: integer (required),
 *     cursor: { mode: "new" | "single" | "filtered" } (required),
 *     submitLabel?: string }
 *
 * Sprint 4: `cursor.mode === "new"` creates a database row on submit and
 * writes child Input values via `set_property_value`.
 */
type FormProps = {
  databaseId?: number | bigint;
  cursor?: { mode?: "new" | "single" | "filtered" };
  submitLabel?: string;
};

export function FormRenderer({ node, children }: BlockRendererProps) {
  const props = useMemo<FormProps>(() => safeParse(node.props), [node.props]);
  const databaseId = normalizeId(props.databaseId);
  const cursorMode = props.cursor?.mode ?? "new";
  const submitLabel = props.submitLabel ?? "Submit";

  const createPage = useCreatePage();
  const setPropertyValue = useSetPropertyValue();
  const { children: dbRows } = useChildPages(databaseId ?? 0n);
  const { schema } = useDatabaseSchema(databaseId ?? 0n);

  const { registerField, collectValues } = useFormFieldRegistry();
  const { submitting, setSubmitting, message, setMessage } = useFormSubmitState();
  const pendingValuesRef = useRef<Map<bigint, import("@/src/module_bindings/types").PropertyValue> | null>(null);
  const prevRowCountRef = useRef(dbRows.length);

  const requestSubmit = useCallback(() => {
    if (databaseId == null) {
      setMessage("Form has no databaseId");
      return;
    }
    if (cursorMode !== "new") {
      setMessage(`Submit for cursor.mode "${cursorMode}" is not wired yet`);
      return;
    }
    if (!schema) {
      setMessage("Database schema not found");
      return;
    }
    const values = collectValues();
    if (values.size === 0) {
      setMessage("Add Input fields inside this form");
      return;
    }
    setSubmitting(true);
    setMessage(null);
    pendingValuesRef.current = values;
    createPage({
      parentId: databaseId,
      pageType: { tag: "Doc" },
      title: "Untitled",
    });
  }, [
    collectValues,
    createPage,
    cursorMode,
    databaseId,
    schema,
    setMessage,
    setSubmitting,
  ]);

  useEffect(() => {
    const pending = pendingValuesRef.current;
    if (!pending || pending.size === 0) return;
    if (dbRows.length <= prevRowCountRef.current) return;

    const newRow = dbRows[dbRows.length - 1];
    if (!newRow) return;

    for (const [propId, value] of pending) {
      setPropertyValue({
        pageId: newRow.id,
        propertyDefinitionId: propId,
        value,
      });
    }
    pendingValuesRef.current = null;
    prevRowCountRef.current = dbRows.length;
    setSubmitting(false);
    setMessage(`Created row "${newRow.title || "Untitled"}"`);
  }, [dbRows, setPropertyValue, setMessage, setSubmitting]);

  useEffect(() => {
    prevRowCountRef.current = dbRows.length;
  }, [dbRows.length]);

  const ctxValue = useMemo(
    () => ({
      databaseId: databaseId ?? 0n,
      cursorMode,
      registerField,
      requestSubmit,
      submitting,
    }),
    [databaseId, cursorMode, registerField, requestSubmit, submitting],
  );

  if (databaseId == null) {
    return (
      <div className="my-3 rounded-md border border-dashed border-amber-300 px-4 py-3 text-sm text-amber-700 dark:border-amber-800 dark:text-amber-300">
        Form — missing databaseId
      </div>
    );
  }

  return (
    <FormContextProvider value={ctxValue}>
      <form
        className="my-3 rounded-md border border-neutral-200 dark:border-neutral-800 px-4 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          requestSubmit();
        }}
      >
        <div className="mb-3 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span className="rounded bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 font-mono">
            Form
          </span>
          {schema ? (
            <span>writes to database</span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">schema not found</span>
          )}
        </div>
        <div className="space-y-1">{children}</div>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting || cursorMode !== "new"}
            className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Submitting…" : submitLabel}
          </button>
          {message && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">{message}</span>
          )}
        </div>
      </form>
    </FormContextProvider>
  );
}

function normalizeId(raw: unknown): bigint | null {
  if (raw == null) return null;
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return BigInt(raw);
  if (typeof raw === "string") {
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }
  return null;
}

function safeParse(s: string): FormProps {
  try {
    return JSON.parse(s) as FormProps;
  } catch {
    return {};
  }
}
