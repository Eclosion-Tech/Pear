"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useReducer, useSpacetimeDB, useTable } from "spacetimedb/react";
import { reducers, tables } from "@/src/module_bindings";
import {
  normalizeGeneratedAutomationId,
  resolveGeneratedUiInput,
  type GeneratedUiFieldSnapshot,
  type GeneratedUiInputBindings,
} from "@/src/lib/generatedUiActions";

type FieldRegistration = {
  getValue: () => string;
  required: boolean;
};

export type GeneratedAutomationAction = {
  automationId?: unknown;
  input?: GeneratedUiInputBindings;
  confirmation?: string;
};

export type GeneratedInvocationStatus = {
  busy: boolean;
  tone: "idle" | "pending" | "success" | "error";
  message: string | null;
};

type Invocation = {
  automationId: bigint;
  idempotencyKey: string;
  clientError: string | null;
};

type GeneratedUiInteractionValue = {
  registerField: (
    name: string,
    getValue: () => string,
    required: boolean,
  ) => () => void;
  invoke: (nodeId: bigint, action: GeneratedAutomationAction) => Promise<void>;
  statusFor: (nodeId: bigint) => GeneratedInvocationStatus;
};

const GeneratedUiInteractionContext =
  createContext<GeneratedUiInteractionValue | null>(null);

export function useGeneratedUiInteraction(): GeneratedUiInteractionValue | null {
  return useContext(GeneratedUiInteractionContext);
}

export function GeneratedUiInteractionProvider({
  messageId,
  children,
}: {
  messageId: bigint;
  children: ReactNode;
}) {
  const { identity } = useSpacetimeDB();
  const invokeAutomation = useReducer(reducers.invokeAutomation);
  const [events] = useTable(tables.automation_event_queue);
  const fieldsRef = useRef(new Map<string, FieldRegistration>());
  const [invocations, setInvocations] = useState(
    () => new Map<bigint, Invocation>(),
  );

  const registerField = useCallback(
    (name: string, getValue: () => string, required: boolean) => {
      const registration = { getValue, required };
      fieldsRef.current.set(name, registration);
      return () => {
        if (fieldsRef.current.get(name) === registration) {
          fieldsRef.current.delete(name);
        }
      };
    },
    [],
  );

  const eventFor = useCallback(
    (invocation: Invocation) =>
      events.find(
        (event) =>
          event.automationId === invocation.automationId &&
          event.idempotencyKey === invocation.idempotencyKey &&
          (!identity || event.invokedBy?.toHexString() === identity.toHexString()),
      ),
    [events, identity],
  );

  const invoke = useCallback(
    async (nodeId: bigint, action: GeneratedAutomationAction) => {
      const automationId = normalizeGeneratedAutomationId(action.automationId);
      if (automationId == null) {
        setInvocations((current) => {
          const next = new Map(current);
          next.set(nodeId, {
            automationId: 0n,
            idempotencyKey: "invalid",
            clientError: "This button does not reference a valid automation.",
          });
          return next;
        });
        return;
      }

      const snapshots = new Map<string, GeneratedUiFieldSnapshot>();
      for (const [name, field] of fieldsRef.current) {
        snapshots.set(name, { value: field.getValue(), required: field.required });
      }
      const resolved = resolveGeneratedUiInput(action.input, snapshots);
      if (!resolved.ok) {
        setInvocations((current) => {
          const next = new Map(current);
          next.set(nodeId, {
            automationId,
            idempotencyKey: "invalid",
            clientError: resolved.error,
          });
          return next;
        });
        return;
      }

      const previous = invocations.get(nodeId);
      const previousCommitted = previous ? eventFor(previous) != null : false;
      const idempotencyKey =
        previous && !previousCommitted
          ? previous.idempotencyKey
          : makeInvocationKey(messageId, nodeId);
      const invocation: Invocation = {
        automationId,
        idempotencyKey,
        clientError: null,
      };
      setInvocations((current) => new Map(current).set(nodeId, invocation));
      try {
        await invokeAutomation({
          automationId,
          inputJson: JSON.stringify(resolved.input),
          idempotencyKey,
        });
      } catch (error) {
        setInvocations((current) => {
          const next = new Map(current);
          next.set(nodeId, {
            ...invocation,
            clientError: error instanceof Error ? error.message : String(error),
          });
          return next;
        });
      }
    },
    [eventFor, invocations, invokeAutomation, messageId],
  );

  const statusFor = useCallback(
    (nodeId: bigint): GeneratedInvocationStatus => {
      const invocation = invocations.get(nodeId);
      if (!invocation) return { busy: false, tone: "idle", message: null };
      const event = eventFor(invocation);
      if (!event && invocation.clientError) {
        return { busy: false, tone: "error", message: invocation.clientError };
      }
      if (!event) {
        return { busy: true, tone: "pending", message: "Submitting…" };
      }
      switch (event.status.tag) {
        case "Pending":
        case "Running":
          return { busy: true, tone: "pending", message: "Running…" };
        case "Completed": {
          const dryRun = event.claimedBy?.endsWith("-dry-run") ?? false;
          return {
            busy: false,
            tone: "success",
            message: dryRun
              ? "Dry run completed — no workspace changes were made."
              : "Automation completed.",
          };
        }
        case "Skipped":
          return {
            busy: false,
            tone: "success",
            message: "Skipped — the automation conditions did not match.",
          };
        case "Failed":
          return {
            busy: false,
            tone: "error",
            message: event.error ?? "Automation failed.",
          };
      }
    },
    [eventFor, invocations],
  );

  const value = useMemo(
    () => ({ registerField, invoke, statusFor }),
    [invoke, registerField, statusFor],
  );
  return (
    <GeneratedUiInteractionContext.Provider value={value}>
      {children}
    </GeneratedUiInteractionContext.Provider>
  );
}

function makeInvocationKey(messageId: bigint, nodeId: bigint): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ui:${messageId}:${nodeId}:${random}`;
}
