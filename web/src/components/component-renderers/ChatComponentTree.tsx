"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import type { AutomationEventQueue } from "@/src/module_bindings/types";
import { StaticComponentTree } from "./StaticComponentTree";

const Events = createContext<ReadonlyMap<string, AutomationEventQueue>>(
  new Map(),
);

/** One queue subscription for the thread, shared by all saved/past panels. */
export function GeneratedUiEventsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [rows] = useTable(tables.automation_event_queue);
  const events = useMemo(
    () =>
      new Map(
        rows
          .filter((row) => row.idempotencyKey)
          .map((row) => [row.idempotencyKey!, row]),
      ),
    [rows],
  );
  return <Events.Provider value={events}>{children}</Events.Provider>;
}

export function ChatComponentTree({
  json,
  messageId,
}: {
  json: string;
  messageId: bigint;
}) {
  const events = useContext(Events);
  return (
    <StaticComponentTree
      json={json}
      messageId={messageId}
      automationEventsByKey={events}
    />
  );
}
