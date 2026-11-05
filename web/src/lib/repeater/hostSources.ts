"use client";

import { createContext } from "react";
import type { ComponentDataSession, ComponentSource } from "@eclosion-tech/trellis";
import type { DataSourceConfig, RepeaterRow } from "@eclosion-tech/pulp";

export type HostSource = {
  source: ComponentSource;
  session: Pick<ComponentDataSession, "query" | "onChange">;
};
export type HostSources = Readonly<Record<string, HostSource>>;

// All repeaters sharing a session share this queue, even across registrations.
const queryQueues = new WeakMap<HostSource["session"], Promise<void>>();
function querySession(session: HostSource["session"], request: Parameters<ComponentDataSession["query"]>[0]) {
  const previous = queryQueues.get(session);
  const result = previous ? previous.then(() => session.query(request)) : session.query(request);
  const settled = result.then(() => {}, () => {});
  queryQueues.set(session, settled);
  void settled.then(() => {
    if (queryQueues.get(session) === settled) queryQueues.delete(session);
  });
  return result;
}

/** Scoped to a host/provider; registration never takes ownership of sessions. */
export function createHostSourceRegistry() {
  const surfaces = new Map<string, { sources: HostSources }>();
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const unregister = (surfaceId: string) => {
    if (surfaces.delete(surfaceId)) notify();
  };
  return {
    register(surfaceId: string, sources: HostSources) {
      const registration = { sources };
      surfaces.set(surfaceId, registration);
      notify();
      return () => {
        // A previous mount's cleanup must not remove its replacement.
        if (surfaces.get(surfaceId) === registration) unregister(surfaceId);
      };
    },
    unregister,
    get: (surfaceId: string) => surfaces.get(surfaceId)?.sources,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type HostSourceRegistry = ReturnType<typeof createHostSourceRegistry>;
export const HostSourceRegistry = createContext<HostSourceRegistry | null>(null);

/** The asynchronous host branch, kept separate from the database evaluator. */
export function subscribeHostQuery(
  registry: HostSourceRegistry | null,
  config: DataSourceConfig & { entity: Extract<DataSourceConfig["entity"], { kind: "host" }> },
  onRows: (rows: ReadonlyArray<RepeaterRow>) => void,
): () => void {
  let closed = false;
  let request = 0;
  let current: HostSource | undefined;
  let unwatch: (() => void) | undefined;
  let rows = new Map<string, RepeaterRow>();
  let running: { entry: HostSource } | undefined;

  const deliver = async () => {
    const version = ++request;
    const entry = current;
    if (!entry || config.limit === 0) {
      rows.clear();
      onRows([]);
      return;
    }
    // Coalesce invalidations while this session is pending, so a burst of
    // registry/watch events cannot exhaust the session's concurrency limit.
    if (running?.entry === entry) return;
    const active = { entry };
    running = active;
    try {
      const { source, session } = entry;
      // A filter on an undeclared field fails closed: widening the result set
      // by dropping the predicate would show rows the author excluded.
      if (config.filter?.some(rule => !Object.hasOwn(source.fields, rule.property))) {
        rows.clear();
        onRows([]);
        return;
      }
      const result = await querySession(session, {
        fields: Object.keys(source.fields),
        ...(config.filter ? { filter: config.filter
          .map(({ property, ...predicate }) => ({ field: property, ...predicate })) } : {}),
        ...(config.sort ? { sort: config.sort
          .filter(rule => Object.hasOwn(source.fields, rule.property))
          .slice(0, 3)
          .map(rule => ({ field: rule.property, direction: rule.dir })) } : {}),
        limit: Math.min(config.limit ?? 200, 200),
      });
      if (closed || version !== request) return;
      // The session changed under this request; keep the current rows and let
      // the onChange re-query replace them instead of flashing an empty list.
      if (result.stale) return;
      const next = new Map<string, RepeaterRow>();
      const delivered = result.status === "ready" ? result.records.filter(record => /^(0|[1-9][0-9]*)$/.test(record.id)).map(record => {
        // Pear/Pulp row ids are bigint, while the Trellis boundary uses strings.
        const candidate: RepeaterRow = { ...record.values, id: BigInt(record.id) };
        const previous = rows.get(record.id);
        const row = previous && Object.keys(previous).length === Object.keys(candidate).length &&
          Object.keys(candidate).every(key => Object.is(previous[key], candidate[key])) ? previous : candidate;
        next.set(record.id, row);
        return row;
      }) : [];
      rows = next;
      onRows(delivered);
    } catch {
      if (closed || version !== request) return;
      rows.clear();
      onRows([]);
    } finally {
      if (running === active) {
        running = undefined;
        if (!closed && current === entry && version !== request) void deliver();
      }
    }
  };
  const reconnect = () => {
    const sources = registry?.get(config.entity.surfaceId.toString());
    const next = sources && Object.hasOwn(sources, config.entity.source)
      ? sources[config.entity.source] : undefined;
    if (next !== current) {
      unwatch?.();
      current = next;
      unwatch = current?.session.onChange(() => { void deliver(); });
    }
    void deliver();
  };
  const unsubscribe = registry?.subscribe(reconnect);
  reconnect();
  return () => {
    closed = true;
    request++;
    unwatch?.();
    unsubscribe?.();
    rows.clear();
  };
}
